# Silent limits — audit of 2026-10-09

The gallery map was missing most located media, and every folder placed
through Unplaced seemed to make more of them disappear (PR #289). The cause
was a cap: `/api/assets/geo` returned the 10 000 newest media, and the map
showed a "+" for the rest. On a 77 670-media library that cap had turned from a
safety net into a window, one that shrank as the work went on.

This audit looks for **the same shape everywhere else**. A screen presents
something as "all of it" while a cap, a page, a fixed choice or an unchecked
answer has quietly made it "part of it". It also covers the neighbours of that
problem: counts in the wrong unit, bulk actions that report success they never
got, answers that land on the wrong list, and position writes that leave the
rest of the row stale.

**Method.** Five read-only audits ran in parallel: server caps, client counts
and bulk actions, position consistency, bulk write limits, pagination and
totals. Every candidate was then checked by hand. Where the instance could
answer, it was measured **read-only on the maintainer's library** with an
editor token: GETs only, counted by paging `/api/assets`. Each fix carries a
test that fails without it, or a browser check where the defect is a UI race.

Status: **Fixed** = shipped in this PR, with the commit named. **Open** = not
fixed here, with the reason.

## 1. Findings

### A. A fixed choice hid what the filter asked for

**A1 — The grid fold hid every group whose fixed member failed a filter.
Fixed** (`791bb37`). `collapseGroups` always hid the companion of a pair and
always showed a pile through its cover, then applied the filter to that one
row. Measured:
- `.arw` listed **1 171 of 44 553** RAWs, because a paired RAW is the
  companion of a HIF that the extension filter rejects.
- Picks were missing **191** frames and Rejects **190**, all rated inside a
  pile.
- A RAW whose HIF had been trashed disappeared from every folded grid.
- Sift stopped offering a pile once its cover was rated.

The fold now chooses, inside each group, a member that passes the same filter
(`filterFold.test.ts`, 7 cases).

**A2 — Every grid page paid for a JIT compile. Fixed** (`64612ff`). This is
the trap already recorded in `docs/memory/database.md`, here hitting the paged
reads. In production a 500-row page took **1.1 s** unfiltered and **2.4 s** on
Unrated. Locally, Unrated went **2 700 ms → 57 ms** with JIT off.
`manyWithoutJit` now applies it per statement.

### B. A bulk action said it was done when it was not

**B1 — Rating, tag and trash helpers ignored the HTTP status. Fixed**
(`c51d9ce`). The grids update first and then announce "N picked" or
"N deleted". A 401, a 5xx or a timeout therefore read as success, and the grid
kept changes the database never received. A failed move to the trash came
back as "0 moved". Checked in the browser: with the rating route forced to
500, the tiles show the pick, return to their previous verdict when the error
arrives, and the error is displayed (`assetActions.test.ts`).

**B2 — Devices' "Apply every proposal shown" swallowed failures and quoted
the client-side total. Fixed** (`c51d9ce`).

**B3 — A selection ZIP over 1 000 files opened a JSON 400 page. Fixed**
(`c51d9ce`). The entry is now disabled and gives the reason.

**B4 — A selection survived filter changes. Fixed** (`489b97a`). Pick and
Delete then acted on media no longer on screen.

### C. An answer landed on a list it no longer belonged to

**C1 — Gallery and session grid: a filter change during a page load showed
the previous filter's media. Fixed** (`489b97a`). The reset fetch was skipped
while a request was in flight. The old answer then filled the emptied grid
with its cursor, and the head of the new results was never fetched. Checked in
the browser: with the first page slowed by 4 s and the Pick chip clicked, the
grid shows **40 of 40 tiles picked**. The Pipeline list and a person's page
had the same race; both are fixed.

### D. Placed media out of step with the rest of the row

**D1 — A geotag kept the old place names. Fixed** (`a4264ea`). A media moved
from Perth to Sydney stayed under Perth in the facets until the geocoder
caught up, or forever with geocoding off. A track Undo kept the names too.

**D2 — From a grid, geotag and "never needs a position" skipped the RAW of a
pair. Fixed** (`a4264ea`). On the instance the pairs are consistent today, so
this was latent. The server now reaches the pair's other member only when it
has no position of its own.

**D3 — A queued EXIF write could put an inferred guess into an original.
Fixed** (`a4264ea`). The job now writes only while `gps_source = 'manual'`.

**D4 — Precise geocoding made one provider call per media. Fixed**
(`a4264ea`). A folder placed at one point cost N identical zoom-18 requests,
which is the bulk use Nominatim's policy forbids. A media at a coordinate
already resolved now copies that answer (`geocodeTwin.test.ts`).

**D5 — The geocoding backlog cannot be seen. Open.** On the instance,
**77 689** media are located and **64 075** have a country. The ~13 600 gap is
absent from the place facets and named nowhere: `/api/stats` carries no
geocode counts, and the geocode job also idles while the scan is paused. Next
step: geocode pending and error counts in `/api/stats`, plus a line on
Settings › Pipeline.

**D6 — Two small fixes. Fixed** (`a4264ea`):
- A pin dragged across the antimeridian sent lon > 180, which the route
  refused.
- Unplaced's "Open grid" on a part could miss frames near midnight UTC.

### E. Lists that stopped short

**E1 — Sift ended at 2 000 cards with "Session sorted!". Fixed**
(`1b04d3b`). It now deals in hands. Typechecked but not exercised in a
browser, since that takes 2 000 swipes.

**E2 — Burst piles were read as one page.** Expand, export and keep-sharpest
used 500 rows, the viewer strip 200. **Fixed** (`1b04d3b`) with
`fetchAllPages`.

**E3 — The Trash showed 200 items in capture order and could not page.
Fixed** (`1b04d3b`).

**E4 — Missing files: "Purge all" purged 200. Fixed in wording**
(`1b04d3b`): the button reads "Purge the 200 listed" past the cap. **Open:**
a purge by filter (`missing_at IS NOT NULL`), like Re-check all, would clear a
moved folder in one gesture.

**E5 — The People facet stopped at 50 people; 49 of 99 named people were
missing from the gallery filter. Fixed** (`1b04d3b`). Merge suggestions now
say "20+".

**E6 — The grid counter compared tiles to unfiltered files. Fixed in
wording** (`1b04d3b`): "N shown · M files in all". **Open:** a filtered,
folded total would need a count over the same `buildFilter` per filter
change.

**E7 — The Heatmap's map shows the 14 busiest places only. Open; the Heatmap
is off on the instance.** Its "no position" bucket also tests `place_id`
rather than `gps_lat`, so every un-geocoded placed media counts as unplaced
there (see D5). Fix both before turning it on: send the map every cell, and
make "no position" mean no position.

**E8 — The gallery map: 60 000 spots, newest first. Open, with headroom.**
The instance has 18 428 spots. Past the cap the map shows only a "+"; it
should say so in words.

### F. Risks recorded, not fixed

- **F1** Geotag of a 20 000-media card enqueues two jobs per row inside the
  request (gpswrite + geocode). Past Cloudflare's 100 s the modal errors while
  the server carries on, and nothing re-enqueues rows left `pending`.
  `enqueueMlBulk`'s chunked `addBulk` is the model to copy. Unmeasured.
- **F2** NULL `captured_at` would break keyset paging: the ORDER BY has no
  NULLS clause and the cursor comparison drops NULLs. The indexer never writes
  NULL (it falls back to mtime), and no NULL was seen.
- **F3** A (0,0) coordinate from a file counts as a real position (`srt.ts`
  rejects it, `extract.ts` does not). The instance has **0** media at null
  island.
- **F4** An inferred position lends its time zone to neighbours as a `'gps'`
  offset (`captureZone.ts`), while the Unplaced donors and `geo?by=day`
  exclude `'inferred'`. This is a design question.
- **F5** A media can be both placed and exempt, so the Unplaced totals can
  add up to more than the library.
- **F6** The points branch of `/api/assets/geo` keeps its 10 000-newest cap
  for Atelier. Any Atelier view that plots it unfiltered has the bug #289
  fixed here; to check on Atelier's side.

## 2. What to keep from this

- A cap on a view that claims "everything" has to be expressed in a unit the
  user's work cannot grow (spots, cells, hands), or the screen has to say it
  in words. A "+" is not saying so.
- A fold, a sample, a cover or a representative is chosen among the rows that
  match the request, never fixed in advance.
- A write is announced after the server answers, from the server's count.
- Every paged list keys its answers on the list they were asked for.
- A position write updates everything derived from the position in the same
  statement, or marks it stale.
