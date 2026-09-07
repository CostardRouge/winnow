# Heatmap — when and where the library was actually made

*A design brief, not a decision. It was written after the feature-flag work of
2026-09-07, in answer to "we made a heatmap in Atelier, I want the same kind of
view here". Nothing below is agreed with the maintainer yet; read it to argue
with it. Every claim about the existing schema and routes was checked against
the tree on 2026-09-07 and carries its path.*

---

## 1. What is being ported, and what is not

Atelier's heatmap (`src/tools/roadtrip/DayHeatmap.tsx`) is a **contribution
grid**: one cell per day of a trip, five rungs from bare paper to the vermilion
accent, and its stated job is *the holes* — the days nothing came out of. It
answers **when**.

The ask here is for **both axes in one view**: when, and where. That is the
choice that makes this worth its own screen rather than a fifth tab in the
Library, because neither half is new on its own —

- the **Calendar** (`src/app/gallery/CalendarView.tsx`) already answers "what
  did I shoot that day", but only one month at a time, and it cannot cross a
  month boundary;
- the **Map** (`src/app/gallery/MapView.tsx`) already answers "where is this
  photo", but it plots one marker per asset, caps at 10 000 points
  (`src/app/api/assets/geo/route.ts`) and flags `truncated` past that — so at
  library scale it is a pin cushion, not a distribution.

What is new is the **crossing**: brush three summers in the grid and watch the
map redraw to only those days; click a bin on the map and watch the grid redraw
to only that place. "Where was I in the summers of 2023–2025" and "when did I
shoot this valley" are questions neither existing view can answer at all.

**Non-goal**: replacing the Calendar or the Map. The Calendar's cover
thumbnails and the Map's per-asset markers are drill-down tools; this is a
step-back tool. They coexist.

---

## 2. The measure is the whole idea

A heatmap whose only measure is *how many frames* is a stat page. The rung
should be a **question**, chosen from a small list, and the same choice colours
both halves at once:

| Measure | The grid says | The map says | Reads from |
|---|---|---|---|
| **Volume** | how much you shot that day | where you shoot most | `count(*)` |
| **Keepers** | the days that produced something | **where you shoot well** | `ratings.verdict = 'pick'`, or `star >= 3` |
| **Keeper rate** | your hit rate that day | the ground that rewards you | `picks / count(*)`, floored at a minimum sample |
| **Backlog** | what is still to cull | where the unculled pile is | `ratings.verdict = 'unrated'` or no `ratings` row |

**Backlog is the one that is uniquely Winnow's.** The project's job is triage;
a map of "everything from these three weeks in Corsica has never been looked
at" is a work queue, not a statistic. It is the measure I would ship first and
default to, with Volume second.

**Keeper rate** is the one that flatters and lies: a day with four frames and
two picks is not a 50 % day. It needs a floor (say 20 frames) below which the
cell draws neutral rather than hot, and the floor must be *stated on screen* —
the same rule the Timeline's automatic granularity follows (an automatic
decision nobody can see is one nobody trusts, `docs/memory/frontend.md`).

`ratings` is a real table with `verdict text CHECK (pick|reject|skip|unrated)`
and `star smallint 0..5`, joined `LEFT` everywhere else in the codebase — an
asset with no row is unrated. All four measures are one `GROUP BY` away.

---

## 3. The temporal half — years, not weeks

Atelier stacks a trip's weeks **horizontally** (53 columns for a year). A
library spans a decade, so the shape has to change: **one row per year,
53 cells wide**, years stacked newest-first. Ten years is ten rows of 53 — it
fits a laptop screen with no horizontal scroll, which the Atelier version
cannot promise (its own comment says a 310-day trip is wider than most
screens).

Kept from Atelier, because they were each a bug someone hit:

- **its own hover card, never the native `title`** — the native tooltip takes
  about a second on the first cell, far too slow for a grid meant to be swept;
- **an empty cell is a normal cell**, drawn, not missing — the holes are the
  point;
- the ramp is **five rungs**, and the legend names both ends in words.

Added, because a library is not a trip:

- a **month rail** above the first year and a year label at the left of each row;
- **undated media are counted and shown**, never silently dropped — the
  Timeline's rule, and there are always some (`capture_date IS NULL`);
- the day is the **UTC** `capture_date` column, and the view says so. Winnow has
  no timezone column; the Timeline works around it by deriving a local day from
  `round(medianLon / 15)` per chapter, which has no meaning for a grid spanning
  the whole library. State the convention rather than invent a fix.

---

## 4. The geographic half — the bins already exist

This is the part that turned out cheaper than expected. Reverse geocoding
already **snaps every coordinate to a grid cell**: `places(cell_lat, cell_lon,
precision_m)` with a unique index on the triple, `precision_m` from the live
setting `geocodePrecisionM` (default 5 000 m), and `assets.place_id` pointing at
it with `country / region / county / city / display_name` attached.

So the coarse bins are already computed, already named, and already indexed.
A `GROUP BY a.place_id` over the filtered set gives a distribution with real
place names for free — no PostGIS, no clustering pass.

For zooming past that cell size, `assets_gps_coords_idx` (a partial btree on
`(gps_lat, gps_lon) WHERE gps_lat IS NOT NULL`) supports the obvious fallback:
`round(lat/step)`, `round(lon/step)` with `step` derived from the map zoom, one
`GROUP BY` per request. Bounded output by construction — a screen holds a few
hundred bins, not 10 000 points — which is strictly better than the current
`/api/assets/geo` cap and could later back the Map view itself at low zoom.

Drawn as **squares/hexes on the map**, on the same five-rung ramp as the grid,
not as a blurred canvas: a blur cannot be clicked, cannot be labelled, and
cannot say "47 frames, 3 picks, Bonifacio". Ungeotagged media get a **counted,
named bucket** off the map ("1 204 frames with no position"), never a silent
omission — the same rule as undated media.

---

## 5. What a click does

Reuse what exists rather than invent a new hand-off. `GalleryShell` already has
both moves: `showDateInGrid` (Calendar → pin the day as a date filter, drop back
to the grid) and `showAreaInGrid` (Map → pin the zone as a bbox filter). The
heatmap gets the same verbs:

- **click a day** → the gallery, filtered to that date;
- **drag across days** → filtered to that span;
- **click a bin** → filtered to that bbox;
- **a bin plus a brushed span** → both filters at once, which is the thing the
  view exists to make possible.

The reading options (`measure`, the brushed span, the pinned bin) go **in the
URL**, like the gallery's filters and the Timeline's `mode`/`gran`/`source`. A
state you cannot link to is a state you cannot show someone.

---

## 6. Where it lives — and why the flags came first

The worry that started this: the Library section's view switcher already
carries Sessions · Grid · Calendar · Map, and the rail already carries six
entries. Anywhere it goes, it crowds something.

**Recommendation: its own route, its own rail entry, its own feature flag.**

The argument is not that a fifth tab is impossible — `SectionView`
(`src/app/gallery/ViewSwitch.tsx`) makes it genuinely cheap, and the view would
inherit the Filters/Browse aside and the date/bbox hand-off for free. The
argument is:

1. **The rail is no longer a fixed cost.** That is exactly what the feature
   flags bought (2026-09-07): the Timeline is off, and Sift / Search / People /
   Gear are each one switch away. An instance that keeps three sections has room
   for a fourth. Adding a rail entry is now a reversible decision, which is what
   made the crowding argument decisive before and no longer does.
2. **It is a way INTO the library, not a tool on it** — the exact reason the
   Timeline sits second in the rail rather than inside the Library section (see
   the comment in `AppRail.tsx`). The heatmap answers a question *about* the
   library and hands you back to the grid; it is not another way to look at a
   filtered feed.
3. **The Library toolbar is wrong for it.** Select-mode, grid density,
   Incoming/Gallery/All — none of them mean anything to a distribution, and the
   toolbar cannot hide them per view without becoming a special case.

**The variant, stated fairly.** A fifth `SectionView` in the Library is
cheaper (no route, no rail entry, filters and hand-off inherited) and it puts
the heatmap where its data already lives. Its cost is the toolbar noise above,
and that it inherits the section's Incoming/Gallery scope whether or not that
makes sense for a decade-wide view. If the rail entry is rejected, this is the
fallback — not "don't build it".

**Either way it carries a flag** (`heatmap`, default off until it is worth
looking at), added to the `FEATURES` registry in `src/lib/features.ts` — one
entry, a rail entry with its `feature` id, `requireFeature()` in the page and
`featureOff()` in its own API routes. Nothing new to build for that.

---

## 7. Data — two routes, no migration

Nothing here needs a schema change. Both routes take the gallery's cumulative
filters through `filterFromSearchParams` / `buildFilter` like every other
aggregate route, so the heatmap is filterable by everything the gallery is.

**`GET /api/assets/heat/days?measure=&from=&to=`**
→ `{ days: [{ date, count, picks, unrated }], bounds, undated }`

One `GROUP BY capture_date` over the filtered set, `LEFT JOIN ratings`. Cheap:
~3 650 rows for a decade, one row per day, and `assets_capture_date_idx` covers
the range. Deliberately **no cover thumbnail per day** — that is the expensive
half of `/api/assets/calendar` (a `DISTINCT ON` per day) and a 14-pixel cell
cannot show one.

**`GET /api/assets/heat/places?measure=&precision=&bbox=`**
→ `{ bins: [{ lat, lon, count, picks, unrated, name? }], untagged }`

`GROUP BY a.place_id` at the geocoding cell size (names come free from
`places`), or `GROUP BY` a rounded lat/lon grid when the requested precision is
finer than `places.precision_m`. Bounded by the viewport, never capped by an
arbitrary 10 000.

Both are `force-dynamic`, both collapse RAW+JPEG pairs with
`buildFilter(..., { collapseGroups: true })` the way the Calendar does, so the
counts line up with the grid a click lands in.

---

## 8. Look — Paper, not a dashboard

- Five rungs from `--color-paper` to `--color-accent`, defined as tokens in
  `globals.css` with night-theme variants — never hardcoded hexes (Atelier's
  `LEVELS` array is the shape to copy, the values are not).
- Counts in **JetBrains Mono**, like every other number in the app.
- The grid and the map share **one legend and one ramp**: two scales would
  break the crossing that justifies the view.
- The whole thing scrolls inside its own container; the page never scrolls
  sideways.
- The hover card is fixed-positioned and pointer-transparent (Atelier's
  `DayCard`), so sweeping the grid is uninterrupted.

---

## 9. Open questions for the maintainer

1. **The name.** "Heatmap" says what it is and matches the plain-noun register
   of Library / Timeline / Sift / Search / People / Gear. *Habits* or *Pulse*
   say what it is *for*. I would ship "Heatmap" and rename if it feels flat.
2. **Default measure** — Backlog (a work queue) or Volume (a portrait)?
3. **Rail entry, or the Library variant of §6?**
4. **Keeper rate at all in v1**, or only after the floor rule has been looked
   at against the real library?
5. **The undated / ungeotagged buckets**: counted beside the view is the
   proposal, but they could also be a filter of their own ("show me what has no
   position") — which is arguably a triage verb worth more than the heatmap.
