# Unplaced — closing the geotagging backlog folder by folder

*Written 2026-09-20 as a brief, **nothing built yet**. The decisions in §4 are
taken, not open; read §2 for the census that justifies them, §6 for the
cross-repo invariant that must not be broken, and §8 for what is genuinely
still undecided.*

---

## 1. The problem

The library is shot with an iPhone, two Sony bodies (A7C II, A6700) and a DJI
Mini 4 Pro. **Only the iPhone and the drone geotag automatically** — neither
Sony has a GPS receiver, and neither is paired to the phone for location. The
two bodies that produce the serious work are exactly the two that produce
position-less files.

The *action* that fixes this already exists, and it is good:

- **`LocationPickerModal`** (`src/app/LocationPickerModal.tsx`) — step 1, pick
  a point: place-name autocomplete over the geocode provider, a click or drag
  on the Leaflet map, or typed lat/lon, three inputs driving one marker.
- **`GeotagRecapModal`** (`src/app/GeotagRecapModal.tsx`) — step 2, the
  per-media before/after list. Media with no position start **checked**; media
  that already have one start **unchecked** and must be opted into explicitly.
  It is the safety net against clobbering a real camera fix in a bulk apply.
- **`POST /api/assets/geotag`** (`src/app/api/assets/geotag/route.ts`) — the
  one write: `gps`, `gps_source='manual'`, then the geocode job (precise) and
  the `gpswrite` job that pushes the coordinates into the original's EXIF.

What does not exist is **the way in**. There is no screen that answers "what
still has no position, and what would be one gesture to fix", no sense of the
backlog shrinking as it is worked, and no shape to the work at all — today the
only route to the recap is a selection a human has already made by hand in the
grid. The action is built; the **queue** is missing.

**Non-goal**: a second geotagging mechanism. Unplaced adds a *view over the
backlog* and a *pre-filled suggestion*, and then opens the modal that already
exists. It writes nothing itself.

---

## 2. The census

Measured 2026-09-20 over the live library. These are the numbers the design
rests on; they are not re-derived elsewhere in this document.

**106 919 live assets, 90 431 without a position — 84.6 %.**

| role | assets | placed | unplaced | % unplaced |
|---|---:|---:|---:|---:|
| final | 7 634 | 1 655 | 5 979 | 78.3 % |
| incoming | 99 285 | 14 833 | 84 452 | 85.1 % |
| **total** | **106 919** | **16 488** | **90 431** | **84.6 %** |

**93.4 % of the backlog is in Incoming.** That, plus §4.1's mount argument, is
why the feature scopes to Incoming and nothing else.

By camera, over the Incoming backlog: **ILCE-7CM2 53 353 · ILCE-6700 28 807 —
97.3 % between them**. Everything else is rounding error: ~1 403 photos and
videos with no camera EXIF at all, ~582 sample RAWs from other bodies, and the
iPhone 15 Pro Max contributing **237**.

That last line corrects an assumption made early and worth stating plainly
because it redirected the whole design: **screenshots and other
never-locatable media are not the problem.** The guess was that a large share
of the backlog would need *exempting* rather than *placing*. It is ~1.7 %. The
backlog is two cameras' worth of real photographs, and it wants placing.

### The shape that matters

Grouping the Incoming backlog by session/folder:

| folder shape | folders | unplaced assets |
|---|---:|---:|
| fully unplaced (one gesture closes it) | 380 | 80 315 |
| mostly unplaced | 21 | 3 300 |
| mostly placed (holes inside) | 33 | 837 |
| fully placed | 19 | 0 |

**380 of the 434 folders holding any unplaced media are entirely unplaced.**
Around 400 human gestures — confirm a folder's location — close 99 % of the
backlog. Not 84 452 decisions: ~400.

This is the whole design in one number. **The unit of work is the folder
group, never the asset.** Anything in this feature that makes a human look at
an individual frame is a design failure, apart from the residue in §8.

### The donor coverage

Measured **per folder**, not per asset (the per-asset version of this
measurement was computed first and is superseded — it answered a question
nobody has to act on, since nobody places one frame at a time): does an
unplaced folder have at least one already-located frame anywhere in the
library whose capture time overlaps, or nearly overlaps, the folder's own
capture window?

| suggestion source | folders | assets covered |
|---|---:|---:|
| a located frame overlaps the folder's own window | 298 | 66 975 |
| within 1 h of the window | 61 | 7 028 |
| within 24 h of the window | 39 | 2 262 |
| nothing within 24 h | 36 | 8 187 |

**359 of 434 folders — 87.6 % of the backlog — have a usable donor**, and the
donor is overwhelmingly the iPhone 15 Pro Max at a **0-minute** gap. The
mechanism is mundane and reliable: the phone is in the owner's pocket while
the Sony is at his eye.

Two spot-checks decided this was signal rather than coincidence: a folder
named *normandie 2026* was suggested La Lande-d'Airou, genuinely in that
region of France; a folder *10060524 farad, fe…* was suggested Pérols, near
Montpellier, plausible for that shoot.

The remaining **36 folders (8 187 assets, 9.7 %) have no donor within 24 h and
stay manual.** That is an expected residue, not a failure — a shoot where the
phone was flat or left at home has no evidence to recover, and inventing one
would be worse than leaving it unplaced.

### Rejected: matching folder names against visited places

Folder names often carry a place (*normandie 2026*), so matching them against
the `places` table — every location the library has already been geocoded
into — looked free. It was tried and **rejected**: only **13 of 434** folders
matched, 2.3 % coverage, and inspection found at least one confident false
positive — a folder whose name contains the French word *espérance* matched
the town of **Esperance, Australia**. A 2.3 % hit rate that can be wrong in a
way no reviewer would catch (the recap shows a coordinate, and Australia looks
like a coordinate) is worse than nothing. Time proximity is the signal;
toponymy is not.

### Day-level coverage, and why it is Atelier's problem

Cross-checked against the day aggregate Atelier consumes (§5): of **641 days**
with any dated media, **493 already have a position (76.9 %)**, 148 have none,
and only **39** of those 148 could be filled from a neighbouring day within
±24 h. Unplaced therefore moves day-level coverage from 76.9 % to **83.0 % at
best**.

So the feature's value is almost entirely at the **media** level — closing the
84 452 — and almost nil at the **day** level. Folder grouping inside Incoming
is Unplaced's job; day-level trip inference is Atelier's. §6 makes that a hard
boundary rather than an observation.

---

## 3. What the feature is

For each Incoming folder group with unplaced media: the group, its capture
window, its media count, and — when §2's donor search finds one — a
**pre-filled coordinate with a stated confidence**. Accepting opens
`LocationPickerModal` seeded with that coordinate, or `GeotagRecapModal`
directly; the human confirms; the existing write happens. Nothing else.

---

## 4. Decisions

### 4.1 Incoming only, never Final

93.4 % of the backlog is there, but the binding reason is physical: the
`gpswrite` job writes into the **original file**, and only `/nas-incoming` is
mounted read-write. The `final` and session mounts are `:ro` in every compose
file (`docker-compose.yml`, `docker-compose-optiplex.yml`) — see
`docs/memory/architecture.md`, "originals are read once", for the rule this
extends. Migration `0031_manual_geotag.sql` already names "read-only mount" as
an expected `gps_write_error`. A position set on a filed asset would land in
Postgres and **silently fail to reach the file**, which is precisely the state
this feature must not manufacture at scale.

### 4.2 A third `gps_source`: `'inferred'`

Today `assets.gps_source` is `NULL` (the file's own EXIF or a telemetry
sidecar) or `'manual'` (a human placed a pin), and the CHECK constraint in
`0031_manual_geotag.sql` allows only those two. Unplaced adds **`'inferred'`**
— a migration at the next free number (`0042`; `0041_app_documents.sql` is
taken) widening that CHECK.

`'inferred'` means: *a human accepted a folder-scale suggestion in bulk, and
did not personally verify each frame.* That is a real epistemic difference
from `'manual'`, where a human placed one pin knowing where that shot was
taken. Both are "a click someone made", and that is exactly the reasoning to
refuse: **accepting one suggestion for a folder of several thousand frames is
not the same act of knowledge as placing one photograph.** The two must never be collapsed.

**How to apply**: anything reaching a coordinate through a folder-suggestion
accept writes `'inferred'`. `'manual'` is reserved for a hand-placed pin, and
a default of `'manual'` in a new code path is a bug.

### 4.3 An `'inferred'` position never enters the original file

Only `NULL` (camera fix — untouched by definition) and `'manual'` positions
get the `gpswrite` treatment. `'inferred'` arms nothing: `gps_write_status`
stays `'skipped'`.

The reason is a laundering cycle, not squeamishness. `runGpsWriteJob`
(`src/lib/exifWrite.ts`) writes the coordinate into the file; a later re-index
reads that file's EXIF back as truth and resets `gps_source` to `NULL` — a
low-confidence bulk suggestion becomes indistinguishable from a real camera
fix **within one re-index cycle**, with nothing anywhere recording that it was
ever a guess.

This is `docs/memory/architecture.md`'s "a deduced location never writes into
an original" (2026-09-03), applied to a new value. That rule was written for
the Timeline's display-only `place_inferred`; the difference here is that
`'inferred'` *is* persisted on the row — it has to be, or the backlog reopens
every session — while staying out of the bytes.

**Consequence, accepted explicitly**: Immich receives a byte copy of the
original (`pushToImmich`, `src/lib/export.ts`), so `'inferred'` media arrive
there **unlocated** and Immich's own map will not show them. Consumers that
want inferred positions read them live from the API (§5). They are true in the
database and never durable in the file — that is the trade, and it is the
right way round.

### 4.4 Grouping is temporal, never spatial

Unplaced groups Incoming folders whose **capture-time windows overlap or
nearly overlap**. The census's per-folder `device_hint` shows one folder = one
memory card, so a two-body outing produces two folders that must merge into
one card in the view — the human took one trip and should make one gesture.

It must **never** group by spatial proximity. That axis is Atelier's (§6):
consecutive *days* within ~25 km, a different unit on a different scale for a
different question. The two are easy to confuse and cheap to "helpfully"
merge; merging them would produce groups that are neither a shoot nor a trip.
Stated here so a future contributor finds the refusal before writing the join.

### 4.5 One path to a coordinate, and it is the existing one

Every application goes through `GeotagRecapModal` → `POST
/api/assets/geotag`. Unplaced contributes a **pre-filled lat/lon and a
confidence level**, and nothing more; it never calls the endpoint itself.
`docs/memory/architecture.md` already states the rule — "never add a fourth
path that skips the recap" — and a screen that exists to apply positions to
80 000 media in ~400 clicks is exactly the one that would be tempted to.

### 4.6 `capture_date` is never touched

Timezone correction is **out of scope**. Several of these folders certainly
carry wrong local times, and a newly-known longitude makes fixing them look
easy. If it ever happens it is a separate, announced operation on its own
screen — never a side effect of a bulk geotag accept, where a human confirming
a *place* would silently have agreed to rewrite a *time*.

---

## 5. The API contract

Specified and being implemented in a parallel task at
`src/app/api/assets/geo/route.ts`; documented here because Unplaced's model and
Atelier's legs both depend on its exact semantics.

**`GET /api/assets/geo?<filters>&by=day`**
→ `{ days: [{ date, lat, lon, count, measured, source }] }`

- `source: "measured"` — the day has positions from real fixes or manual pins.
  The position is computed from **those rows only**; `'inferred'` rows are not
  mixed in when a trustworthy row exists that day.
- `source: "inferred"` — the day's *only* positioned rows are `'inferred'`.
- `source: null` — the day has assets and zero positioned rows. A **declared
  gap**: `lat`/`lon` null, the row still present. Never silently omitted —
  the same rule as the Heatmap's undated and ungeotagged buckets
  (`docs/HEATMAP.md` §3–§4).
- The position is the **median** of the relevant subset, not the average: one
  frame from the airport must not drag a day's position across a country.

---

## 6. Boundary with Atelier

Atelier is a sibling app in its own repository that calls this API
cross-origin (`docs/memory/auth.md`). It is building **trip legs**: consecutive
days grouped by spatial proximity (~25 km, configurable) into legs, with the
`by=day` aggregate above as its **only** input.

Atelier's rule, recorded here because it depends entirely on Winnow's
`source` field being correct: **an `"inferred"` day is a bridge, never a
vote.** It prevents an unnecessary leg break — the trip did not stop just
because the phone was off — but it never contributes to the leg's centroid or
geometry. The reason is in §2's day numbers: the 39 days fillable from a
neighbour are disproportionately **travel days**, the ones where the true
position is neither yesterday's nor tomorrow's, and letting them vote would
silently drag a leg's location away from the stop it is supposed to name.

**The invariant.** If Winnow ever collapses `"inferred"` into `"measured"` —
by defaulting a new write path to `'manual'` (§4.2), by a migration widening
the CHECK the wrong way, by an aggregate that mixes subsets when it should
prefer — **Atelier's legs quietly become wrong, and there is no local signal
anywhere that anything happened.** No exception is raised, no count changes; a
leg simply sits 30 km from where the trip was. This is the single most
important thing in this document, and it lives in a field, a query's subset
choice, and one CHECK constraint.

---

## 7. The screen

*Shipped 2026-09-20, the same day as the brief.* `/library/incoming/unplaced`
is a fifth view beside Sessions · Grid · Calendar · Map. It sits **right after
Sessions**: `GalleryShell` places injected views before its built-in ones, and
the two folder-level views reading side by side, ahead of the asset-level
ones, is the better order anyway. One card per folder group, drawn with the
session card's own markup (`.session-card`, the meta line, `ThumbStrip`) — a
folder group is a session-shaped thing and a second card family for the same
object would be drift. The primary verb is **Place N**; the `⋯` menu holds
*Pick a different place…*, *Exempt N without camera EXIF* and *Open in grid*.
The suggestion, its confidence and its provenance are printed on the card;
the rules that produced them are printed above the list (§8). Every session
card in the Sessions view now carries an **N unplaced** pill linking here —
the invite this brief started from. `GET /api/assets/unplaced`
(`src/lib/unplaced.ts`) is two scans under `jit = off`: the folders with
something left to place, then the donors for every group at once, the group
windows passed as `unnest` arrays.

---

## 8. What the build settled

1. **The donor rules, fixed and printed** (`UNPLACED_RULES`,
   `src/lib/unplacedTypes.ts`; the route returns them with the data). Folders
   whose capture windows come within **2 h** share a card. Donors are the
   **trustworthy** located frames — `gps_source` NULL or `'manual'`; an
   inferred position never seeds another inference, or the backlog would fill
   itself with copies of one iPhone frame — within **±1 h** of the card's
   window, **±24 h** failing that. The suggestion is the dominant geocoding
   cell's median point; its confidence is the share of donors in that cell,
   **≥ 90 % high, ≥ 60 % medium**, else low, and never above low under
   **5 donors**. High and medium pre-fill the map; low is shown and not
   seeded. Accepting the pin as offered (within **100 m**) records
   `'inferred'`; moving it further, or placing with no suggestion, records
   `'manual'`. All six numbers are on screen, in a sentence, above the list —
   the rule the Timeline's granularity chip and the Heatmap's keeper-rate
   floor already follow.
2. **Per-media exemption shipped.** `assets.geo_exempt_at` (`0042`),
   `POST /api/assets/geo-exempt`, the bulk bar's *Never needs a position* /
   *Needs a position again* in both grids, the card's *Exempt N without camera
   EXIF* (`camera_model IS NULL AND lens IS NULL`, §2's discriminator), and
   `geo_state=exempt` in the shared filter to find them again. Per asset,
   never per folder.
3. **The recap folds.** Past 200 media, `GeotagRecapModal` summarises the
   position-less rows in one line and keeps the table for the rows that
   already carry a position — the ones the dialog exists to protect.

4. **The media list is one lean request.** `GET /api/assets/geotag/targets`
   returns exactly the nine columns the recap draws, unpaged, for one session
   or a whole folder group (`session_ids`). The first cut paged through
   `/api/sessions/:id/assets` — the full `GRID_SELECT` projection, 500 rows at
   a time, eight requests for a 3 886-frame folder — to populate a table of
   five columns. The endpoint drops exempted media itself (they are not
   targets) and keeps both members of a RAW+JPEG pair (the companion file
   needs the coordinates too). Past a 20 000-row cap it answers `truncated`
   and the client refuses to apply: a recap listing 20 000 of 25 000 media
   would write 20 000 and look finished. The three no-grid entry points — the
   session card, the session header, Place — share it.

**Still open**: the 36 donor-less folders stay a hand job, by design.
