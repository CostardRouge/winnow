# Instructions for LLM agents (Claude Code, Codex, Cursor, etc.)

Agents read this file at the start of every session. These rules override the agent's default behaviour and apply for the whole session, not only the first turn.

## Context

- Winnow indexes, culls and exports the RAW photos/videos on a home NAS without touching the originals more than once. Next.js 16 (App Router) + React 19 + TypeScript 7 on Node ≥ 22, backed by Postgres and a Redis/BullMQ queue set; `sharp` + `exiftool-vendored` build the derivatives, Tailwind 4 styles the UI. Package manager: **npm** — the lockfile is `package-lock.json` (the only lockfile in the tree).
- It ships as a Docker image: a push to `main` builds and publishes `ghcr.io/costardrouge/winnow` (`.github/workflows/docker-build.yml`), and Watchtower re-pulls it on the Optiplex that runs the whole stack behind Traefik + a Cloudflare Tunnel.
- Commands that actually exist here: `npm run dev` (UI + API on :3000), `npm run worker` (the BullMQ workers), `npm run typecheck` (`tsc --noEmit`), `npm run migrate` (applies `db/migrations/`), `npm run build`. **There is no linter and no test suite** — no ESLint config, zero automated tests (`docs/ARCHITECTURE-REVIEW.md` §3.5). The gate is `typecheck` + `migrate` + `build`, exactly what CI runs. `make help` lists the docker-compose wrappers.
- Several agent sessions may run **in parallel** on this repo. Git history must stay readable: **one commit = one task**.
- **Local sessions: never `git push`** — the developer tests locally and pushes himself. **Cloud / web sessions (ephemeral container): push the working branch and open a pull request**, it is the only way the code gets out. Never push to `main` either way.

## Rule 1 — Automatic commit at the end of every task (MANDATORY)

As soon as a task requested by the user is finished (feature, fix, refactor, content…), the agent MUST create a commit before handing back. No need to ask permission: it is the expected behaviour.

### Exact procedure

1. **Check the state**: `git status --porcelain` and `git diff --stat`.
2. **Select only the task's files**:
   - Stage file by file with `git add <path>` (never `git add -A`, `git add .` or `git commit -a`).
   - A modified file unrelated to the task (parallel session, tooling noise) stays **unstaged**. Do not touch it, stash it or reset it.
   - If one file holds changes from this task AND another, prefer `git add -p <file>` to stage only the relevant hunks. If inextricable, stage the whole file and say so in the commit body ("also contains …").
   - Never stage: `.env` and any secret file, `.idea/`, `.vscode/`, `.next/`, `out/`, `build/`, `dist/`, `coverage/`, `*.tsbuildinfo`, `node_modules/`, `.DS_Store`, and the local media/data roots `nas/`, `data/`, `backups/`, `dump.rdb`, `/nas-incoming`, `/nas-final` — unless the task is explicitly about them. `.env.dist` is the exception: it is the tracked, documented template and a new variable **must** be added to it. If one of these turns out to be *tracked*, say so: it must be untracked and gitignored, not carefully avoided at every commit.
   - Check with `git diff --cached --stat` before committing.
3. **Commit with a readable message** (format below). Always use a HEREDOC to keep title + body:

   ```bash
   git commit -m "$(cat <<'EOF'
   Imperative title, ≤ 72 characters, no trailing period

   Why this change, what it does concretely, non-obvious decisions.
   One line per idea. Mention the files/areas touched if useful.

   Co-Authored-By: Claude <noreply@anthropic.com>
   EOF
   )"
   ```

4. **Do not push** (local sessions). End the reply with a recap: short hash + commit title + the list of files that were modified but deliberately **left uncommitted**, if any, so the user knows where every change comes from.
5. If a git hook changes or refuses something: read the output, fix, recommit. Never `--no-verify`. (There is no hook in this repo today — `core.hooksPath` is unset and `.git/hooks` holds only samples.)

### Commit message format

- **Title**: English imperative, clear sentence, ≤ 72 chars, no `feat:`-style prefix, no trailing period — the rule `CONTRIBUTING.md` states, describing the user-visible effect. Real examples from this repo: `Add per-body shutter count to the gear shelf`, `Block Pinterest extension hover badge on cover thumbnails`. The history also carries a lowercase `area: subject` variant (`people: rank merge picker by similarity first, not by name`) and, before ~#195, a few conventional-commit prefixes (`fix(compose): …`); those are drift, not the convention — follow `CONTRIBUTING.md`.
- **Blank line**, then a **body**, mandatory whenever the title is not enough: the *why*, the *how* in 2–6 lines, the trade-offs, what remains to do. The body is what lets someone find, weeks later, which feature produced this diff.
- A commit **never** mixes two tasks. If a session handles several distinct tasks, make several successive commits.
- No empty commit, no "WIP" commit, no commit for an unfinished task. If the task is interrupted, leave the work uncommitted and say so.

### When is a task "finished"?

- The requested code is written **and** verified: `npm run typecheck` green, plus `npm run migrate` when the change touches `db/migrations/` and `npm run build` when it touches anything the production build compiles — these three are the whole CI gate, so a red one is a broken PR. For a rendering change, also look at it in the browser.
- A plain question, an exploration or an explanation produces **no** commit (nothing to commit).

## Rule 2 — Project memory in `MEMORY.md` + `docs/memory/` (MANDATORY)

The repo carries its own long-term memory, read locally and in the cloud alike:

- **`MEMORY.md`** at the root — the **index**, imported below and therefore loaded every session: how to maintain the memory, how the maintainer works, direction and decisions at a glance, open items, and a table of topic files.
- **`docs/memory/<topic>.md`** — one file per area, loaded **on demand**. Not imported here on purpose: the split keeps the per-session prompt small.

Obligations:

- **Read `MEMORY.md`, then the topic file(s) for the area you are about to touch, before acting** — to understand previous choices and not re-propose what was rejected. The table at the bottom of `MEMORY.md` maps areas to files.
- **Every task writes to memory by default.** At the end of each task (feature, fix, refactor, content, and any exploration that learned something), ask: "what should a future agent know that is neither in the code nor in `git log`?" — decisions and their reasons, rejected options, traps and remedies, working preferences. Write it in the matching topic file (update the existing entry first; delete what became false; add a short dated *decision → why → how to apply* entry otherwise), and update the index if a cross-cutting decision, an open item or a new topic file is involved. **If, exceptionally, there is nothing worth keeping, say so explicitly in the final message** ("no memory update: …") — silence is not an option.
- The memory update is part of the task: it is staged **in the same commit** (rule 1).
- Memory is written in **English**, dense and factual; no session narration, no duplication of what the code, `git log` or this file already say; each fact stated once, cross-referenced by file name elsewhere.
- The project command `/memorize` (`.claude/commands/memorize.md`) does this consolidation on demand over a whole conversation.

@MEMORY.md

## Verification — trust the disk, not the context

- A tool answering "success" is not proof. Before saying a change is done, prove it through the repo: `git status --porcelain`, `git diff`, `grep` for the expected value, `git show HEAD:<file>` compared to the file on disk.
- What you hold in context (an earlier `Read`, an old `ls`, a summarised conversation) can be **stale**: it has produced sessions where `Edit` reported success while nothing changed on disk, and where an agent described a tree that had not existed for weeks. Signature: `git status` clean right after an announced change. Re-read from disk before concluding.
- Never state an absence ("this feature is missing", "that file does not exist") without a `git`/`grep` check made in the current turn.

## Other rules

- Never rewrite history (`rebase -i`, `commit --amend`, `reset --hard`, `push --force`, `filter-repo`) without an explicit request.
- Do not modify `.git/config`, the hooks or branch settings.
- **The originals are sacred.** The NAS session mounts are read-only and the RAWs are read once (index + derivative generation); browsing, culling and queries go through Postgres and the derivative cache, and deletes are *soft* deletes. A change that mutates or re-reads originals needs a very good reason (`README.md`, guiding principle).
- **A new environment variable lands in three places or it does not work**: the `envSchema` in `src/lib/config.ts` (with a default and bounds), the exported `config` object next to it, and `.env.dist`. The schema fail-fasts at boot, so a variable read from `process.env` anywhere else is a bug. Adding it to `docker-compose-optiplex.yml`'s `x-winnow-env` anchor too is what keeps production able to tune it (see `docs/memory/deployment.md`).
- **Migrations are append-only and their number must be unique**: add `db/migrations/NNNN_*.sql` with the next free number after the highest one present, never edit or rename an applied file. `db/migrations/README.md` carries the full convention and the renumbering history; `src/lib/migrate.ts` carries the `RENUMBERED` shim that has to be extended whenever a rename is unavoidable.
- `src/lib/config.ts` is server-only (it holds the S3 credentials): only `NEXT_PUBLIC_*` variables may be read from a client component.

## Related files

- `AGENTS.md`: points to this file for tools that do not read `CLAUDE.md`.
- `MEMORY.md` + `docs/memory/`: project long-term memory (rule 2).
- `CONTRIBUTING.md`: the human-facing version — setup, the CI gate, the code conventions. Read it once; it is the source this file defers to on commit style and migrations.
