# Capture time — correcting a clock that was wrong

*Written 2026-11-24. §3 answers the question the maintainer asked (which date
can be changed); §10 lists the calls that are his. **C1 answered the same day:
database only. Phases 1–3 (§9) are built** — migrations `0061_capture_shift`
and `0062_capture_zone_manual`, `lib/captureCorrections.ts`,
`lib/clockSuggestions.ts`, `lib/immichDates.ts`, `app/CaptureTimeModal.tsx`;
phase 4 (writing into the originals) is not, by C1.
Mockups: the "Winnow — Capture time correction" canvas (five boards: the field
decision, the viewer, the dialog, a session page, the corrections list in
Settings).*

---

## 1. The request

> Encore une fois, j'avais oublié de régler la time zone de mon appareil et
> j'ai des médias qui se retrouvent sur le mauvais jour.

He wants to reassign the capture date of selected media, one or many, from the
viewer, the session page and the grids, "a bit everywhere". And he wants to
know first which date is the one to change: the file's creation date, the
capture date, or the EXIF.

It happens again and again. The memory already records one case: his Sony
stayed on `+10:00` for months in France after the trip (`docs/memory/database.md`,
« The capture DAY is the place's local day »). 0046 absorbed that one because
the place decides the day. This brief covers the cases 0046 cannot absorb.

## 2. What Winnow does today

- `captured_at` (timestamptz) is read once per index from the first date tag
  that holds an instant: `DateTimeOriginal`, `SubSecDateTimeOriginal`,
  `CreateDate`, then `MediaCreateDate` (`readCaptureTime`, `src/lib/extract.ts`).
  `captured_at_source` records how it was read. `exif` means a zoned instant,
  `exif-wall` a wall clock with no zone stored as if it were UTC, and `file`
  means no date tag at all, so the file's mtime stands in.
- The **day** is not computed from `captured_at` alone. The 0046 trigger files
  it in the PLACE's local day: `capture_offset_min` comes from the frame's
  own GPS, a GPS track, a neighbouring frame from any device within 12 h, or
  failing all three the camera's own `OffsetTimeOriginal`
  (`capture_offset_source`: `gps` > `track` > `neighbour` > `exif`).
- Nothing lets a human change either value. A re-index rewrites `captured_at`
  from the file whenever the file's size or mtime changes.

So "the wrong day" is one of two different faults, and only one of them is in
`captured_at`:

| | A · right moment, wrong zone | B · wrong moment |
| --- | --- | --- |
| How it happens | The camera's zone (Sony "Area") stayed at home and the camera **wrote** it (`+01:00` in Brisbane) | The clock was set by hand to local time with the zone still at home, or the file states no zone at all (DJI, older bodies, `exif-wall`), or a summer-time change was missed |
| `captured_at` | correct | off by N hours |
| Day today | correct when a place is known (GPS, track, a phone frame within 12 h); wrong when Winnow falls back to the camera's `exif` offset | wrong, and 0046 cannot see it: the neighbour pass trusts the instant |
| Fix | set the zone: `capture_offset_source = 'manual'` | shift the moment: `captured_at` moves |

The info panel cannot tell the two apart today. It prints one "Date" row and
neither provenance (`AssetMeta.tsx`). The first diagnostic step costs nothing:
print the day's zone and where it came from (§6.1).

## 3. Which date can change — decision

| Candidate | Verdict | Why |
| --- | --- | --- |
| The file's date on the NAS (mtime, birthtime: « date de création ») | **No** | It is the scanner's change detector (`indexer.ts`: size + mtime), so touching it makes the next scan re-read the file as modified. Birthtime cannot be set from Linux over NFS or SMB. It only stands in for a capture date when the file has none (`'file'`). |
| The EXIF inside the original | **Not by default.** A later opt-in, the maintainer's call (§8) | New bytes mean a new `content_hash`. The Incoming copy stops matching its Gallery twin, and the full-content compare that dedup relies on no longer finds them. A clip written in place costs about 4× its size in NAS I/O (`docs/memory/architecture.md`, BE-05), and his clips run to 1–8 GB. Sony and DJI keep another date in their maker notes, which `-AllDates` does not reach. QuickTime stores its dates in UTC, so a wall-clock shift written without `-api QuickTimeUTC` moves a clip by its offset. Precedent: a corrected camera body is not written either (0048). |
| `captured_at` in Postgres | **Yes**, as a shift stored beside what the file says | Every screen, filter, API and Atelier already read it, and the day follows through the 0046 trigger. The file's own time stays beside it, so the viewer can say "file says …" and Revert has something to restore. A re-index recomputes it as file time + shift instead of wiping it. A selection gets one number, so the gaps between frames stay as shot. |

**What this costs, said plainly**: anything that reads the NAS directly keeps
the file's date. That means Capture One, Immich's own EXIF read of a pushed
copy (§5) and the Finder. The folder an import filed a file into is named after
the file's date (`planDestination`, `src/lib/import.ts`), and it keeps that
name: Winnow never moves an original to follow a correction.

**Why a shift and not a typed date**: the fault is a clock that was off by a
constant amount. One number per gesture keeps bursts, pairs, ordering and the
1/3 s between bracket frames intact, survives a re-index, and undoes exactly.
"Set the date" of one frame is the same thing (shift = typed − file).

## 4. Data model (proposal, migration `0061`)

```sql
ALTER TABLE assets
  ADD COLUMN captured_at_file    timestamptz, -- what the file says (or its mtime for 'file'), refreshed on every index
  ADD COLUMN capture_shift_s     integer,     -- the human correction; NULL = none
  ADD COLUMN capture_correction_id bigint REFERENCES capture_corrections(id) ON DELETE SET NULL;
-- backfill: captured_at_file = captured_at (no row is corrected yet)

CREATE TABLE capture_corrections (           -- one row per Apply, what Undo keys on
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id bigint REFERENCES users(id),
  via text NOT NULL,                         -- 'ui' | 'agent' (cf. ratings.rated_via, 0050)
  mode text NOT NULL CHECK (mode IN ('shift','match','zone','set')),
  shift_s integer,                           -- NULL for a zone-only correction
  zone_from text, zone_to text,              -- IANA names, mode 'zone'
  report jsonb NOT NULL                      -- the confirmed preview: counts, days, effects
);
-- capture_offset_source gains 'manual' (0042's find-the-real-CHECK idiom)
```

- **Invariant**: `captured_at = captured_at_file + make_interval(secs => COALESCE(capture_shift_s, 0))`.
  It is the only rule the writers in §5 need, and a test asserts it.
- **`captured_at_source` keeps meaning "how the FILE's time was read"**. A
  shifted `exif-wall` row is still a wall clock, and the trigger still adds no
  offset to it. The shift is visible as its own column, never as a new
  source value.
- **`'manual'` zone** (fault A) is the strongest `capture_offset_source`: the
  passes in `captureDays.ts` and the indexer must leave it alone, as they
  leave `'track'` to the track's Undo. Whether it should also beat the frame's
  own GPS is a call (§10, C3).
- The 0046 trigger already re-fires on `captured_at` and `capture_offset_min`,
  so the day re-files itself with no trigger change.

## 5. Every writer and reader that must learn the shift

Writers. A shift that one of these wipes is a correction that silently
reverts:

| Where | What it does today | What it must do |
| --- | --- | --- |
| `indexer.ts` UPDATE (≈ l. 317) and INSERT (≈ l. 471) | `captured_at = file time` | write `captured_at_file`, and `captured_at = file + COALESCE(capture_shift_s,0)`: the same kind of guard as `device_source = 'override'` and `gps_source IN ('manual','inferred','track')` |
| `captureDays.ts` re-read (≈ l. 475) | writes the re-read time into `captured_at` | write `captured_at_file`, recompute `captured_at` |
| `captureDays.ts` step 0 (≈ l. 282, 384, 392) | the invariant `'file' ⇔ captured_at = file_mtime` | compare `captured_at_file`, or every corrected `'file'` row is handed back to the re-read |

Readers that must be refreshed after an Apply or an Undo:

| Where | Consequence | Action |
| --- | --- | --- |
| `sessions.captured_at_min/max` (`indexer.ts` ≈ l. 645, `relink.ts` ≈ l. 365) | the session's span | recompute for the touched sessions (extract the shared statement) |
| neighbour zones (`captureDays.ts`) | a moved frame can be, or lose, a donor | re-run the neighbour pass over the moved frames and their 12 h window |
| `gps_source = 'track'` positions (`trackImport.ts`, `track_points`) | the track placed them at the OLD instant | re-match against `track_points` at the new instant, reported in the Apply's report, never silently |
| track conflicts (> 25 km at that instant) | a conflict is often precisely a wrong clock | they become evidence for a suggestion (§7) |
| `reconcile.ts` (l. 77–90) | matches finals to sources on **exactly equal** `captured_at` | compare `captured_at_file` on both sides. A Capture One export carries the file's original date, so a corrected source would otherwise lose its edit |
| bursts (`bursts.ts`) | piles are never dissolved | take whole piles into the selection (§6.3), so nothing is cut |
| Timeline named spans / forced breaks (0040) | stored as instants | a moved frame may leave a named span: acceptable, said in the report |
| `gear_owners` date spans (`shotByLine`) | "mine until Mar 2016" reads `captured_at` | follows by itself |
| Immich push (`export.ts` ≈ l. 489) | sends `fileCreatedAt = captured_at`, but Immich reads `DateTimeOriginal` from the bytes | after the upload, set `dateTimeOriginal` through Immich's API (its own "change date"), and do the same for media already pushed (§10, C2). Check against the instance's Immich version |
| Atelier (`/api/assets`, `geo ?by=day`) | reads `captured_at` and `capture_date` | follows with no change on its side. A day that moves can change a trip leg, which is what the fix is for |
| filters, calendar, heat, Unplaced, `?by=day` | read `capture_date` / `captured_at` | follow by themselves |

## 6. The gesture

### 6.1 Seeing it

The viewer's info panel gets two rows (board 2):

- **Date**: the time Winnow uses, then `corrected +9 h — file says Mon 11 Nov,
  20:41` when a shift exists, followed by *Change…* and *Revert to the file*.
  It reads like a corrected camera body already does ("corrected — file says …").
- **Day**: `12 Nov, Brisbane time (UTC+10) · zone from its position / from the
  camera / borrowed from a frame 40 min away`. This is the line that tells
  fault A from fault B on one frame.

### 6.2 Entry points: one dialog

*Correct capture time…* in the viewer's ⋯ (proposed key **T**, free today),
the per-media context menu (`AssetActionMenu`), and the ⋯ of `BulkActionBar`
wherever it is mounted (Gallery, session grid). Every entry opens the same
dialog. A new entry point reuses it and never brings a picker of its own: the
`GeotagRecapModal` rule.

### 6.3 The dialog (board 3, interactive)

1. **Whose clock was wrong?** The selection broken down by body (`device`),
   with checkboxes. Only ticked bodies move. An unticked body is the reference
   the preview compares against, because in practice a session mixes a right
   clock (the phone) with a wrong one. RAW+JPEG and Live Photo companions
   always move with their frame (`companions: true`, the geotag contract). A
   pile cut by the selection is taken whole, and the dialog says so.
2. **How do you know the right time?** Four ways (one `OptionPicker`, four
   segments), all of them producing a shift:
   - *Shift by*: ± hours and minutes, with presets (−1 h summer time, +1 h,
     +1 day, the shift computed from the frames' place).
   - *Match a frame*: one frame from the wrong clock, one from a right clock,
     the same moment. Pairs are suggested from CLIP look-alikes within the
     window (`/api/assets/[id]/similar` already exists). Rounding to the
     nearest 15 min is on by default, because a zone fault is a whole number
     of quarter hours while a drifting clock is not.
   - *Time zone*: "the camera was on Europe/Paris, I was in
     Australia/Brisbane". The difference is computed **at those dates**, summer
     time included. Per frame, this resolves fault A vs B on its own. A file
     that states the camera's zone had the right moment, so only its day's
     zone is set (`'manual'`). A file that states no zone is shifted.
   - *Set the time*: one frame's local time typed in, the others keep their
     gaps from it. With one media selected, this is "change its date".
3. **Preview**: days before → after (counts per day), sample frames with the
   nearest frame of the reference body, and **What follows**: the session's
   new span, the track positions re-matched, the neighbour zones recomputed,
   the piles and companions, Immich.
4. **Apply** writes one `capture_corrections` row, then the shifts, then the
   refreshes from §5, all in one transaction except the re-match report.
   **Undo** (Settings › Pipeline › Dates & places, a fourth step, board 5) takes
   back only the rows still carrying that correction id.

### 6.4 API (shape, to settle at build time)

- `POST /api/assets/capture-time` with `{ ids, companions: true, bodies,
  mode, shift_s | zone_from+zone_to | pair: {wrong_id, right_id, round} |
  set: {id, local} , apply: false }` returns the preview. With `apply: true`
  it returns the record.
- `GET /api/pipeline/capture-corrections` lists the corrections, and
  `DELETE …/:id` undoes one.
- Role: **editor**, like geotag. An app token (capped at editor) and the
  agent's MCP command can do it, recorded with `via = 'agent'`.

## 7. Detection, suggestions only

A heuristic never moves a frame. It offers a card that opens the dialog
pre-filled (board 4 on a session page, board 5 in Settings):

- **Track conflicts**: a body's frames that the track puts > 25 km away, and
  that all land within 25 km at one whole-hour shift. The data is already in
  the import report.
- **Two bodies in one session**: shifted by Δ, the frames of body X fall
  within a minute of look-alike frames of body Y (CLIP). Δ is the suggestion.
- **Camera zone ≠ place zone** (fault A): `exif_offset` disagrees with a `gps`
  or `track` offset over a whole session. This is a diagnostic, since 0046
  already files those days right where a place is known. **Not built**: once a
  place's offset replaces the camera's, the camera's own `OffsetTimeOriginal`
  is no longer stored anywhere (0046 keeps one offset per row), so this needs
  a column and a re-read first.

As built (2026-11-25, `lib/clockSuggestions.ts`): the pairs evidence samples
up to 80 photos per body per session, takes each one's most alike photo of
another body within ±26 h (CLIP cosine ≥ 0.9, same model), rounds the gaps to
15 min and suggests the gap at least three twins and 60 % of them agree on;
the body that moves is the one whose files carry the fewest positions of their
own. The track evidence needs three frames with their own position in
conflict (> 25 km) and a shift of whole half-hours (±14 h) that puts four in
five back. A session's page shows its own suggestions under the toolbar band
(Review opens the dialog pre-filled over the whole session); Settings ›
Pipeline › Dates & places looks over the 60 most recent sessions with two
bodies or more, or own positions beside a track, on demand, and says so.
*Not a mistake* is remembered per session, body and shift
(`capture_clock_dismissals`). Without pgvector the pairs evidence is off.

## 8. Writing into the original, later (opt-in, maintainer's call)

If Capture One and Immich must see the corrected date on the NAS itself, the
write has the `gpswrite` shape. It is a job queued per media and never cut by
a timeout (`exifWriter()`), written then re-read, with
`-AllDates+=` / `-OffsetTime*` on photos and `-api QuickTimeUTC` on clips. The
maker-note date is either left (and said) or written per vendor. Its
consequences must be written into the dialog before anyone ticks it:

- The hash changes. `content_hash` is recomputed, and an Incoming copy no
  longer matches its Gallery twin.
- The I/O is about 4× each file's size.
- After the write, `captured_at_file` equals the corrected time and
  `capture_shift_s` drops to 0. Undo then becomes another write, not a
  database revert.

Not in phases 1–3.

## 9. Phases

1. **The shift — built 2026-11-24.** Migration 0061, the writers of §5, *Shift
   by*, *Set the time* and *Back to the file*, the viewer's two rows, the entry
   points (viewer ⋯ and T, context menu, both bulk bars, a session's ⋯), Undo
   in Settings › Pipeline › Dates & places step 4. Tests
   (`captureCorrections.test.ts`): the invariant across a re-index, a re-read
   and an Undo (stacked too), ticked bodies only, piles and pairs whole, *Set
   the time* from the local wall clock, the capture-day step 0 and reconcile
   against `captured_at_file`. As built, three things differ from §4–§6:
   the invariant is enforced by the trigger (a writer that sets `captured_at`
   alone speaks for the file), a row's before/after shift lives in
   `capture_correction_assets` so Undo restores exactly what it replaced, and
   `'track'` positions placed at the old moment keep it — the dialog counts
   them; re-matching is phase 2.
2. **The other two ways — built 2026-11-25.** *Time zone*: a file that wrote
   its zone (`'exif'`, or the mtime of a `'file'` row) keeps its moment and
   gets the place's zone as `'manual'` (0062); a wall clock (`'exif-wall'`)
   is shifted by `offset(to) − offset(from)` at its own date and zoned the
   same way. *Match a frame*: the gap between the two frames' local wall
   clocks, rounded to 15 min unless unticked; candidates are other bodies'
   photos within ±26 h, CLIP first, then the perceptual hash, then time.
   *Back to the file* left the segmented control (four methods fit it, five
   would turn it into a menu) for a link beside it; it also takes off a
   `'manual'` zone. A `'track'` position is matched against its own import at
   the new moment on Apply — moved, or taken off when the track has no fix
   then — and `capture_correction_assets` keeps the before/after zone and
   position so Undo restores them exactly instead of re-deriving them.
   Immich: after the commit, every moved media with an `exports.kind =
   'immich'` row gets `dateTimeOriginal` (PUT /api/assets/:id, its own
   "Change date", with the place's offset); a push of a corrected media does
   the same right after the upload. A refusal is counted on the correction's
   report and never fails the gesture. Untested against a real Immich: the
   call is the one its web UI makes, checked by a fake in the tests.
3. **Suggestions — built 2026-11-25** (§7, "As built").
4. **Optional write-back** (§8), if the maintainer asks for it.

## 10. The maintainer's calls

- **C1** — *answered 2026-11-24: database only.* Database-only, as §3
  recommends, or the write-back of §8 from the start?
- **C2**: should Immich be corrected through its API, for future pushes and
  for media already pushed? *Built as proposed with phase 2 (both), on the
  maintainer's "go phase 2 et 3".*
- **C3**: does a hand-set zone (`'manual'`) beat the frame's own GPS zone?
  Proposed: yes. A human who says "I was in Brisbane" knows better than a
  zone lookup at a border. *Built as proposed: `'manual'` is rank 5 in
  `lib/captureZone.ts`, and a track import places such a frame without
  re-zoning it.*
- **C4**: who may correct: editor (proposed, like geotag) or admin? *Built as
  proposed (editor); his to overturn.*
- **C5**: the key, **T** in the viewer? *Built as proposed.*
- **C6**: confirm that an import folder named after the wrong day stays as it
  is (proposed: yes, Winnow does not create or rename structure in the
  originals' world beyond the import).

## 11. What not to do

- Never overwrite `captured_at` without keeping `captured_at_file`, or a
  re-index reverts the correction and Revert has nothing to restore.
- Never apply a shift a heuristic proposed without the dialog. The rule is the
  same as geotag's: no fourth path past the recap.
- Never move a file because its day changed.
- Never compare a corrected `captured_at` with a file-derived date
  (reconcile, dedup reports, an export's EXIF). Compare `captured_at_file`.

## 12. Not measured

The app token in this session's environment was revoked, so nothing here is
counted on the instance. Before phase 1, two read-only counts would size it:
how many rows sit on an `exif` offset while a `gps` or `track` frame of
another body falls within 12 h (fault A that a place could fix), and how many
track conflicts resolve at one whole-hour shift per body and session
(fault B).
