# Open in Atelier — handing media from Winnow to the editing half

Brief, 2026-11-28. **Nothing in it is built.** It answers the open item both
repositories carry — Winnow's "which surfaces get *Edit in Atelier*"
(Atelier's `docs/winnow-bridge.md` §10) and Atelier's "Winnow's entry points
into Atelier are undesigned, deliberately" (its `docs/memory/architecture.md`,
2026-09-02) — with one mechanism, a **hand-off**, and lists the calls that are
the maintainer's (§10). Mockups of §4.3 and §4.4 (the dialog on desktop, when
a check fails, on a phone; the session's band; the viewer's line) are on the
"Winnow — Open in Atelier" canvas.

The ask, in his words: develop a session, a video or an image "directly, via a
link to the other tool"; pass arguments (the folder path, the session name…);
"maybe" an intermediary modal that picks the Atelier tool, checks the
connection between the two and confirms the selection; "maybe" keep, on the
Winnow session, the link to what was started there, so an edit in progress is
one click away.

---

## 1. What exists today (read in both repositories, 2026-11-28)

**Winnow → Atelier: nothing.** No page of Winnow links to Atelier. `grep -ri
atelier src/app` finds comments, the agents guide and the token panel, and no
`href`. No variable names Atelier's address: `CORS_ALLOWED_ORIGINS`
(`src/lib/config.ts`) lists origins that may *call* Winnow, which is a
different fact.

**Atelier → Winnow: everything a hand-off needs to land on.**

| Atelier already has | Where | What it gives this brief |
| --- | --- | --- |
| Hash routing, deep links that survive static hosting | `src/app/use-hash-route.ts` | a landing route costs no server |
| `#/sources?instance=<url>&return=<hash path>` — a link PROPOSES an instance, nothing is sent before *Allow*, then it lands on `return` | `src/app/SourcesScreen.tsx` | the connection check, already built |
| Links from Winnow into Trips that a person confirms on a screen (`#/roadtrip/new?source=<host>&chapters=…`) | `src/shared/roadtrip/trip-route.ts` | the precedent: `source` is the instance's HOST, resolved against the connections this browser holds |
| Per-tool routes to a document (`#/develop/<ref>[/<picture>]`, `#/roadtrip/<ref>/…`, `#/studio/open/<id>`) | `src/shared/develop/develop-route.ts` … | the address a link back from Winnow opens |
| A Winnow asset enters a document as a REF (`assetId` + source), its bytes fetched on open | its `docs/memory/develop-media.md` | Atelier needs ids, never paths |
| The send-back: `POST /api/upload` with `original_asset_id` | Winnow `docs/memory/architecture.md`, «An uploaded edit is linked by the import» | the return leg is closed: a final knows its source |
| Cookie mode (same site) and app-token mode (home-screen app, another site) | Winnow `docs/memory/auth.md` | both credentials reach any new route |

So the cheap half really is cheap — but "a link" alone does not meet three of
the four asks: a URL cannot carry a 2 000-frame selection, should not carry a
NAS path, and leaves nothing behind for "the edit in progress".

## 2. The rules this has to keep (all already decided elsewhere)

1. **The URL says WHAT to open, never WHERE to fetch from** (Atelier's
   `winnow-bridge.md` §3.4). The instance is a host Atelier resolves against
   the connections it holds; an unknown one falls through to `#/sources` and
   its *Allow*. A hand-off link never makes Atelier talk to a server the person
   did not name.
2. **Winnow stays ignorant of Atelier's nouns** (Atelier's `winnow-timeline.md`
   §3.3): no roll, no trip, no post, no "edited" status in Winnow's schema.
   The one opaque exception is the document bucket (`app_documents`, which
   Winnow stores and never reads).
3. **Lineage beats a status field** (same §3.3): "has this been edited?" is
   answered by the finals that came back with `original_asset_id`, not by a
   flag someone has to keep in sync.
4. **Not an iframe** (`winnow-bridge.md` §8 C: `showDirectoryPicker` is refused
   in a cross-origin iframe). A new tab.
5. **Connecting is the user's act, and nothing runs at boot** on Atelier's side.
6. **Originals are sacred**: nothing here reads or writes one. Atelier fetches
   derivatives (or the original, by its own existing "original on request").

Rule 2 is the one the fourth ask presses on. §4.4 is how it holds.

## 3. The design in one paragraph

A **hand-off** is a row Winnow writes when a person clicks *Open in Atelier*:
who, which media (ids, frozen), which session they came from, which tool was
suggested, when. The link Winnow opens carries only the instance's host and
that row's id: `https://atelier.…/#/handoff?source=<host>&id=<uuid>`. Atelier's
landing checks the connection (its existing `#/sources?…&return=`), reads the
row, lets the person confirm the tool and the target (a new roll, or one
already started), builds the document, and **claims** the hand-off: it tells
Winnow which document it became (kind, id, title, the hash route to reopen it).
That claim is an opaque pointer, as opaque as `app_documents.doc`. Winnow then
lists, on the session and on the frame, *In Atelier*: the pointers its people
were given, and the finals that came back.

```
Winnow                                   Atelier
──────                                   ───────
[Open in Atelier…] ─ modal (§4.3)
  POST /api/handoffs  → id
  open tab ─────────────────────────────► #/handoff?source=winnow.steeve.website&id=…
                                           ├ host not connected → #/sources?instance=…&return=<this>
                                           ├ GET /api/handoffs/:id   (cookie or token)
                                           ├ "48 media from «Noosa, 14 March» → Develop"
                                           │   [New roll] [Add to «Noosa edits»]   ← person confirms
                                           ├ builds the document from refs
                                           └ POST /api/handoffs/:id/claim {kind,id,title,route}
session page: In Atelier ◄────────────── (pointer stored, never read)
  «Noosa edits» · Develop · 2 d ago · 3 finals back   [Open ↗]
```

## 4. The parts

### 4.1 The hand-off is a row, not a long URL

**Why a row**: (a) a session is routinely 1 000–3 000 frames; ids in a hash
work up to a point and then fail in a way nobody sees (the Silent-limits
audit's class of bug); (b) a folder path in a URL lands in the browser's
history, its sync, and the tunnel's logs; (c) the row is what the fourth ask
needs anyway — the URL would otherwise be the only record that a hand-off
happened; (d) the selection is read through the API with the person's own
credential, so a forwarded link is useless to anyone else (404, below).

**Shape** (migration at merge time — next free number is `0063` today, but take
it when the PR merges, `docs/memory/database.md`):

```sql
app_handoffs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app         TEXT NOT NULL,                 -- 'atelier'; a second client is a value
  user_id     BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  session_id  BIGINT REFERENCES sessions ON DELETE SET NULL,
  scope       TEXT NOT NULL,                 -- 'asset' | 'selection' | 'session' | 'picks' | 'favourites'
  tool_hint   TEXT,                          -- opaque: 'develop', 'studio', … (§10 H4)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at  TIMESTAMPTZ,
  target      JSONB                          -- the claim, opaque: {kind,id,title,route}
)
app_handoff_assets (handoff_id UUID REFERENCES app_handoffs ON DELETE CASCADE,
                    asset_id BIGINT REFERENCES assets ON DELETE CASCADE,
                    position INT, PRIMARY KEY (handoff_id, asset_id))
```

- **Owned like `app_documents`**: `user_id` on every query, a foreign id is a
  **404, never a 403**. A viewer may hand off (it is a read, plus a row of its
  own, as with documents: `/api/handoffs` joins `SELF_SERVICE_PREFIXES`).
- **The selection is FROZEN** at the click, in the grid's order: "the 48 I
  sent" stays 48 when the filter later moves. A `session` scope stores the
  session's ids at that moment too (§10 H6 asks whether a living one is wanted).
- **Retention**: an unclaimed hand-off is dropped after 30 days (the
  `import_links` rule); a claimed one lives until its owner forgets it or the
  user goes. No automatic writer otherwise, so no janitor beyond that delete.

### 4.2 What Atelier is given (the "arguments")

`GET /api/handoffs/:id` answers what the landing screen prints and what a tool
needs to build its document — Winnow's nouns only:

```json
{ "id": "…", "scope": "session", "tool_hint": "develop", "created_at": "…",
  "session": { "id": 812, "name": "Noosa", "folder": "2025-03-14 Noosa",
               "captured_from": "…", "captured_to": "…", "path": "…" },
  "counts": { "photo": 41, "raw": 41, "video": 7 },
  "assets": [ { "id": 123, "kind": "photo", "captured_at": "…", "has_proxy": true }, … ],
  "target": null }
```

- `session.name` and the folder's **last segment** are what a person reads;
  Atelier may name the new roll after them.
- `session.path` (the full `source_path`) is only there for Atelier's
  local-files mode, which may say "this is `/Volumes/…/Noosa` on the NAS" next
  to its folder picker. It is **displayed, never acted on**, and §10 H5 asks
  whether it should be sent at all.
- `assets` are ids plus the facts the landing needs to warn ("7 videos have no
  proxy yet") — everything else Atelier already reads from `/api/assets` the
  way it does today.
- The 30-day drop, the 404 for a foreign id and the frozen ids are the whole
  contract; `GET /api/capabilities` advertises `handoffs: { version: 1 }` so
  Atelier shows nothing on an older instance, never a broken landing.

### 4.3 The modal on Winnow ("Open in Atelier…")

One dialog, wherever it is opened from (the repo's rule: a new entry point
reuses the dialog, `docs/memory/frontend.md`, «ONE dialog places media in
bulk»):

1. **What** — the count drawn once, split by kind (41 photos · 41 RAW · 7
   videos), and a scope picker for the session entry point: *All · Picks ·
   ♥ · The selection* (the shared "one of N" picker). RAW+JPEG pairs count
   once, as the grid does.
2. **Where in Atelier** — a short list of tools that can take this media:
   *Develop* (photos, RAW), *Studio* (video and photos), *Trips* (a day or a
   span), *Let Atelier ask*. A tool that cannot take the media is shown
   greyed with the reason, never hidden. The last choice is remembered
   (`localStorage`, a per-viewer convenience).
3. **Continue or start** — if this session already has a claimed hand-off to
   that tool (§4.4), "Add to «Noosa edits» (Develop, 2 d ago)" is offered
   beside "New". Choosing it puts the target in the row, and Atelier's landing
   pre-selects it.
4. **Checks** — the facts Winnow can actually know, each a line with its fix:
   - Atelier's address is set (`ATELIER_URL`, §5); if not, the verb is not
     shown at all.
   - Its origin is in `CORS_ALLOWED_ORIGINS` — without it every call Atelier
     makes back will fail, so the dialog says so and names the variable.
   - **Your role**: a viewer can open; sending finals back needs editor.
   - **Derivatives**: "7 of 48 have no proxy yet — Atelier will show them when
     they are ready".
   - **Last seen from Atelier**: the last time this account's Atelier claimed
     a hand-off, if ever. Winnow cannot see whether *this browser's* Atelier
     is connected (that lives in Atelier's storage). It says so plainly, and
     the landing does the real check.
5. One primary action: **Open in Develop ↗**.

**Entry points, in the order proposed** (§10 H3): the viewer (one frame,
context menu + the info sheet), the bulk bar (the selection), a session's ⋯
(the session, its picks, its ♥). Later: a folder card, a calendar day, and the
Timeline's chapter once the Timeline is on (Atelier's Trips links already
exist for it).

### 4.4 "In Atelier" on the session, and on the frame

The fourth ask without breaking rule 2: **Winnow stores the pointer Atelier
hands back, and its own lineage, and nothing that describes the edit.**

- **Session page**: a band *In Atelier* listing this account's claimed
  hand-offs from this session: the target's title, the tool (an opaque word
  Atelier gave), who, when, **finals back** (assets whose `original_asset_id`
  is one of the hand-off's ids, counted live from Winnow's own data), and
  **Open ↗** (`ATELIER_URL` + `#` + `target.route`). Unclaimed ones read
  "Sent, not opened yet" with *Forget*.
- **Viewer info sheet**: "In 2 Atelier documents" with the same links, from
  `app_handoff_assets`.
- **What it cannot show, said on the band**: documents built in Atelier from
  its own picker, without going through a hand-off. §10 H2 asks whether
  Atelier should claim those too (a hand-off created *by Atelier*, already
  claimed, so the pointer exists either way).
- `target.route` is stored as Atelier gave it and only checked to be a hash
  path (`/…`, not `//`, not a scheme — Atelier's own `return=` rule). Winnow
  never builds a per-tool route itself, so a renamed Atelier route breaks only
  Atelier's own stored strings, which Atelier can rewrite on its next claim.

### 4.5 Atelier's half (for an Atelier session, not this repo)

Listed so the two halves can be built in parallel; nothing here touches
`CostardRouge/atelier`.

1. A `#/handoff?source=<host>&id=<uuid>` route: resolve `source` like
   `trip-route.ts` does; not connected → `#/sources?instance=https://<host>&return=<this route>`.
2. `GET /api/handoffs/:id` through the existing client (cookie or token —
   `/api/handoffs` is an ordinary API route, so the token works unchanged).
3. A confirmation screen: what came, which tool (the hint pre-selected, the
   person decides), new or an existing document, the warnings from §4.2.
4. Each tool's "new from Winnow refs" seam (Develop's roll from refs; Studio's
   `#/studio/new?source=&assets=` sketched in `winnow-bridge.md` §3.4; Trips'
   seed).
5. `POST /api/handoffs/:id/claim { kind, id, title, route }` — again on later
   saves when the title changes (idempotent, last write wins).
6. When `capabilities.handoffs` is absent, nothing of this is drawn.

## 5. Configuration

`ATELIER_URL` — one new variable, server-side, in the three places
(`envSchema`, `config`, `.env.dist`) plus `x-winnow-env` in the Optiplex
compose. Empty (the default) hides the verb everywhere. Not `NEXT_PUBLIC_*`:
the address is read on the server and handed to the pages, so changing it
needs a restart, not a rebuild (`/settings/instance` prints it with its
source). The CORS check in §4.3 compares its origin with
`CORS_ALLOWED_ORIGINS`; the two are kept separate on purpose — one says where
to *send* people, the other who may *call*.

## 6. API, in full

| Route | Who | Does |
| --- | --- | --- |
| `POST /api/handoffs` `{ asset_ids \| session_id + scope, tool_hint, target_handoff? }` | any signed-in role | freezes the ids, answers `{ id, url }` |
| `GET /api/handoffs/:id` | owner | §4.2 |
| `POST /api/handoffs/:id/claim` | owner (cookie or token) | stores `target`, sets `claimed_at` |
| `GET /api/handoffs?session_id=` / `?asset_id=` | owner | the §4.4 band, with `finals_back` |
| `DELETE /api/handoffs/:id` | owner | *Forget* |

Writes require `Content-Type: application/json`, like the document bucket,
so the forced preflight (only an allowlisted origin passes) stands in for the
CSRF token Winnow does not have (`docs/CODEBASE-AUDIT.md` SEC-03, D1).

An agent command (`atelier.handoff`, `src/lib/commands/`) is a natural later
step: "send today's picks to Develop" from Claude, through the same route.

## 7. Phases

- **P1 — the hop.** Winnow: `ATELIER_URL`, the migration, `POST`/`GET`, the
  dialog on the viewer and the bulk bar, the capabilities flag. Atelier: the
  landing, connection fall-through, Develop's "new roll from refs", the claim.
  Usable alone: a frame or a selection opens in Develop in one confirmation.
- **P2 — the memory.** The session's ⋯ entry, the *In Atelier* band and the
  viewer line, *Continue* in the dialog, finals back.
- **P3 — the rest.** Studio and Trips as targets, Atelier-originated claims
  (H2), folder and day entry points, the agent command.

## 8. Rejected

- **The selection and the path in the URL** (`…&assets=1,2,3&path=/nas/…`):
  §4.1 (a)–(d). Kept only as the shape Atelier's bridge sketched for a handful
  of ids; one transport is simpler than two.
- **Winnow building per-tool routes** (`#/develop/new?…`): it couples Winnow to
  Atelier's route table. One landing route, Atelier routes from there.
- **Finding "documents using this session" by reading `app_documents`**: it
  breaks the opacity rule, and a roll is tens of MB of JSON to scan.
- **An "edited" status on assets**: rule 3 — the finals are the evidence.
- **`postMessage` between two open windows**: nothing persists, both tabs must
  be alive, and a phone has one.
- **An iframe panel**: rule 4.

## 9. Traps, before they are discovered

- **The popup blocker.** `POST` then `window.open` after the answer is not a
  user gesture any more. Open the tab synchronously in the click
  (`window.open('about:blank')`), then set its `location` when the id comes
  back; close it on an error and say why in the dialog.
- **`noopener`** on the new tab, and never hand Atelier a `window.opener`.
- **The phone.** A link opened from Winnow on an iPhone opens Safari, not the
  Atelier home-screen app, and Safari's Atelier has its own connection store
  (Atelier's `docs/memory/storytelling.md`, «per browser and per address»). It
  may land on *Allow* the first time — that is the rule working, not a bug;
  the landing should say it.
- **`source` must be the host as Atelier's `sourceIdFor()` mints it**
  (lowercase, port kept, no scheme), or a connected instance looks unknown.
- **A frozen id may be trashed later**: Atelier gets a 404 for that frame and
  says "gone from Winnow", the rest open. The join cascades on purge.
- **`Vary: Origin`** on the derivative routes is still Atelier's open item
  (its `architecture.md`, 2026-09-21): hand-offs will make Atelier read many
  more thumbnails Winnow's own pages cached first. Worth shipping with P1.

## 10. The maintainer's calls

- **H1 — whose hand-offs does a session show?** Sessions are shared, Atelier
  documents are per account, so another user's link would open an empty
  bucket. Proposed: your own with links, others' as a count ("2 more by
  Marie"), no link.
- **H2 — should Atelier claim documents built from its own picker?** Proposed
  yes, in P3: otherwise *In Atelier* only knows what started in Winnow, and
  the band must say so forever.
- **H3 — the entry points and their order.** Proposed: viewer, bulk bar,
  session ⋯; folder card and calendar day later.
- **H4 — who owns the tool list?** Proposed: Winnow carries a short *hint*
  list (Develop, Studio, Trips, Let Atelier ask), Atelier's landing is the
  authority. The alternative — a manifest Atelier publishes — is a network
  call from Winnow's page to a static host, for a list that changes rarely.
- **H5 — send the full NAS path?** Proposed: the folder's name always, the
  full path only behind a setting, since only Atelier's local-files mode can
  use it and it is the one argument that describes the box.
- **H6 — a session hand-off frozen or living?** Proposed: frozen (the
  repo's rule against a list that silently differs from what was shown), with
  "12 new frames since — add them?" on *Continue*.
- **H7 — the verb's name.** *Open in Atelier…* on the generic entry, the tool
  in the primary button (*Open in Develop ↗*). "Edit" promises an editor
  Trips and Recap are not.
