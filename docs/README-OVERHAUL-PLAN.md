# Winnow README Overhaul — Plan

## Context

Winnow is a self-hosted Next.js/TypeScript media-management tool (ingest / cull / export) for photographers and videographers working off a NAS — think a self-hosted alternative/companion to Capture One's culling step and Immich's library, purpose-built for high-volume RAW/video triage (Sift swipe-culling, burst stacking, map/calendar/people views, CLIP semantic search, Immich export).

The current `README.md` (1,038 lines) is a thorough **engineering reference** — architecture, full API table, env vars, migration notes — but has zero marketing framing: no screenshots, no features list, no "why use this" pitch, no use cases, no badges, no table of contents, and nothing structured for GitHub's own search/SEO (topics, first-paragraph keywords, social preview). The goal is to make the repo's front door appealing to a stranger landing on it from GitHub search, while keeping the deep technical reference material available for people who clone it.

This document is the plan. It ships first, on its own, so the structure and content approach can be reviewed before the actual README rewrite (or a GitHub Pages site) is built on top of it.

## Deliverable for this pass

- This file: `docs/README-OVERHAUL-PLAN.md`.
- No changes to `README.md` itself yet — that's the next pass, once this plan is reviewed.

## Proposed new README structure

Keep the existing technical content (Architecture, API table, env vars, migrations, backups, PWA, etc.) — relocate/collapse it under a "Reference" section or `<details>` blocks rather than deleting it. Add a new marketing-oriented front section:

1. **Banner/logo + title + one-line pitch** — reuse/expand `public/icons/icon.svg` mark; title `Winnow — self-hosted RAW photo & video culling for your NAS`.
2. **Badges row** — license (MIT), Docker build (`docker-build.yml`), CI (`ci.yml`), GHCR image link. All derivable from existing workflows, no new infra needed.
3. **Short pitch paragraph** (SEO-critical: the first ~150 words are what GitHub search snippets and Google surface) — plain-language description using target keywords: self-hosted, RAW photo culling, NAS media manager, digital asset management (DAM), Immich companion, Capture One alternative, photo triage.
4. **Screenshots / GIF strip** — Sift swipe-culling, Gallery grid, Map view, Gear page (see shot list below). Placeholder image tags with descriptive alt text if real screenshots aren't captured this round.
5. **Why Winnow / Features** — condensed bullet list distilled from the 40+ concrete features already documented (ingest feeders, dedup, Sift, burst stacking, map/calendar/people, CLIP search, Immich export, multi-user, backups, PWA). Group under: Ingest, Cull, Organize & Discover, Export & Integrations, Ops.
6. **Use cases** — 3–4 concrete scenarios:
   - "I shoot Sony A7C II + drone + iPhone and need one culling queue."
   - "I want CLIP semantic search across 100k photos on my own hardware."
   - "I need to reconcile Lightroom/Capture One exports back to RAW sources."
   - "I want Immich as my viewer but need real culling tools first."
7. **Quick start** — Docker Compose (the real distribution path — GHCR image), 3–5 command block, link to full setup in the reference section.
8. **Table of contents** — for the collapsed reference sections below.
9. **Reference (collapsed/linked)** — existing Architecture, API table, env vars, keyboard shortcuts, migrations, backup/restore, PWA install, roadmap — largely moved as-is.
10. **Contributing / License** — link `CONTRIBUTING.md`, MIT license badge/link.

## Screenshot / visual shot list (for the follow-up capture pass)

No screenshots exist in the repo today (only PWA icons in `public/icons/`). Shot list to capture later via the dev Docker Compose stack + seeded sample media:

1. `/sift` — swipe-triage deck (hero shot/GIF, most visually distinctive feature)
2. Gallery grid view with filters panel open
3. Map view with a zone-culling box drawn
4. Calendar view
5. Gear page (auto-generated camera/lens SVG art)
6. People page (face clusters)
7. Before/After (finals ↔ sources) viewer

## SEO checklist (GitHub + general web discoverability)

- Repo **topics** (repo Settings, not a file): `self-hosted`, `photo-management`, `raw-photos`, `photo-culling`, `digital-asset-management`, `nextjs`, `postgresql`, `nas`, `photography`, `immich`.
- Repo **description** field ("About" box) — short one-liner mirroring the README pitch. Also a settings action item.
- **Social preview image** — repo Settings → upload an OG image (1280×640) for link unfurls on Slack/Twitter/etc.; candidate to generate from the Sift screenshot once captured.
- First 1–2 README paragraphs front-load keywords naturally (GitHub/Google snippet weight).
- Descriptive image `alt` text on every screenshot (accessibility + image search).
- Keep heading hierarchy clean (`#`/`##`/`###`) for anchor-link SEO and GitHub's auto TOC.
- Cross-link `CONTRIBUTING.md`, `docs/ARCHITECTURE-REVIEW.md`, `docs/BACKUP.md` from the README so they're discoverable, not orphaned.

## Open decisions for the next pass

- **README vs. GitHub Pages**: leaning README-first, since GitHub's own search/ranking indexes README + repo metadata, not Pages content. GitHub Pages could be a stretch goal later for a richer marketing site.
- **Screenshots**: ideally captured live from the dev stack; this plan's shot list works either way — real captures now, or placeholders swapped in later.

Both should be confirmed before the rewrite pass starts.
