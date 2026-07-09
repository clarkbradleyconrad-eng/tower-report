# Tower Report — Content & Data Architecture

**Last verified:** July 8, 2026 (full audit of cron/commit logic, all `fetch()` call sites, and complete `git log --author="Tower Report Bot" --name-only` history).

## The invariant

> **No automated process ever writes to an `.html` file. Bots write data; pages render it client-side.**

Audit result: this has always held. The bot's entire commit history touches only `data/roster.json`, `data/briefing.json`, `data/story-queue.json` (+ `data/stories.json` per the old workflow's `git add` list). Every write target in `.github/scripts/*.py` resolves to a path under `data/`. No script opens an `.html` file for writing.

It is now also **enforced**, not just observed: the workflow's commit step stages only `data/roster.json` and then fails the run if `git diff --cached --name-only` contains anything outside `data/` (see `.github/workflows/update-roster.yml`).

> One related incident class *did* exist and was fixed on 2026-07-08: the bot rebuilt `data/roster.json`'s `team` object from a hardcoded literal, silently discarding hand-added JSON fields (`offensiveCoordinator`, `defensiveCoordinator`). That was a bot overwriting hand-edited **data**, never HTML. `update_roster.py` now merges scraped data over the existing `team` block, so hand-maintained fields survive.

## Three content planes

Tower Report has three independent automated content stores. None of them touch page markup.

### 1. Git-committed JSON — `/data` (GitHub Actions bot)

| Producer | Schedule | Writes |
|----------|----------|--------|
| `.github/workflows/update-roster.yml` → `update_roster.py` | daily 06:00 UTC | `data/roster.json` only |

The workflow scrapes texaslonghorns.com, rewrites `data/roster.json`, commits as "Tower Report Bot", and pushes — which triggers a Vercel deploy of the static files. The former `aggregate_news.py` / `generate_stories.py` steps were removed 2026-07-08 (their output had no consumers); the scripts remain in `.github/scripts/` if ever revived.

**Client-side readers of `/data`:**

| File | Read by (browser `fetch`) | Read server-side by |
|------|---------------------------|---------------------|
| `data/db.json` — **unified data layer** (teams, players, games, stories; schema in README.md) | `players.html` (via `js/tower-db.js`), `player-profile.js` (loaded on 9 pages) | `api/stories-refresh.js` (Grok grounding) |
| `data/roster.json` | `roster.html` | `api/stories-refresh.js` (grounding) |
| `data/depth-chart.json` | — | `api/stories-refresh.js` (grounding) |
| `data/facts.json` — **hand-verified program facts** (coach, conference, recruiting cycle; null = unverified, see NEEDS-VERIFICATION.md) | — | `api/stories-refresh.js` + `api/generate-story.js` (prompt grounding + story rejection gate) |
| `data/recruiting.json` — **hand-verified recruiting data** (commits, targets, portal, needs, timeline) | `recruiting.html` | `api/verify-recruiting.js` (prompt baseline) |
| `data/portal.json`, `data/recruiting-targets.json`, `data/odds-cache.json`, `data/briefing.json`, `data/stories.json`, `data/story-queue.json`, `data/stats/*` | **no consumers** — candidates for deletion or future wiring | — |

> 2026-07-08: `data/players.json` and `data/schedule.json` were migrated into `data/db.json` and deleted. `db.json` is hand-curated (human-owned, never bot-written); `data/roster.json` remains the bot's only write target and serves as the raw upstream for the curated `db.json.players` set. Integrity check: `node scripts/validate-db.mjs`.

Pages whose content is currently inline in the HTML (schedule, depth-chart, recruiting, portal, stats, history) are **hand-edited by design**; no bot produces their data, so there is no overwrite path. If any of them later become bot-fed, the rule is: bot writes a new `data/*.json`, the page fetches it client-side — never a templated HTML rewrite.

### 2. Vercel Blob — live AI content (Vercel cron)

`vercel.json` schedules `/api/daily-refresh?slot=am` at 06:00 and `?slot=pm` at 18:00 UTC (distinct query strings — Vercel collapses cron entries whose paths are identical). It orchestrates, in order: `briefing?cron=1` → `generate-story` → `stories-refresh` → `verify-recruiting` → `odds?cron=1`, each step individually try/caught, with a heartbeat written per run. The former `tiktok-drafts` step (and its Supabase table + `desk.html` UI) was removed 2026-07-09.

| Blob | Written by | Served by | Rendered client-side on |
|------|-----------|-----------|--------------------------|
| `tower-briefing.json` | `api/briefing.js` | `GET /api/briefing` | `index.html` briefing panel |
| `tower-ai-stories.json` | `api/stories-refresh.js` | `GET /api/stories` | `stories.html`, `index.html` analysis grid |
| `tower-stories.json` | `api/stories-db.js` (newsroom CMS) | `GET /api/stories-db` | `stories.html`, `newsroom.html` |
| `tower-refresh-log.json` | `api/daily-refresh.js` (heartbeat) | `GET /api/health` | `stories.html` footer status |
| `tower-recruiting-live.json` | `api/verify-recruiting.js` (Grok daily class-rank check) | `GET /api/verify-recruiting` | `recruiting.html` "Live · via Grok" block (labeled, never overwrites `data/recruiting.json`) |

`/story?id=…` (`api/story.js`) is the one server-rendered surface — an edge function that renders a story/briefing item to HTML **at request time** for OG/share tags. It renders from Blob; it never writes any file.

### 3. Supabase — removed

The Supabase plane (TikTok `tiktok_drafts` table + `desk.html`) was deleted 2026-07-09 along with the whole TikTok pipeline.

## Write-access matrix (who may write what)

| Actor | data/*.json | Vercel Blob | *.html |
|-------|-------------|-------------|--------|
| GitHub Actions bot | ✅ `roster.json` only (guard-enforced) | ❌ | ❌ **never** |
| Vercel crons (`daily-refresh` chain) | ❌ (read-only for grounding) | ✅ | ❌ **never** |
| Newsroom editors (authed endpoints) | ❌ | ✅ via `stories-db` | ❌ |
| Humans (you / designer) | ✅ | — | ✅ sole owners |

## Rules for future automation

1. A bot that needs to change what a page shows writes a JSON file under `data/` (or a Blob behind an `/api` endpoint) — the page fetches and renders it in the browser.
2. Never generate, template, or rewrite `.html` in any scheduled job. The workflow guard will fail any bot commit that stages a file outside `data/`.
3. New workflow commit steps must stage explicit `data/` paths (no `git add -A`, no globs outside `data/`) and keep the guard step.
4. Bots that rewrite an existing JSON file must merge over hand-maintained fields, not rebuild objects from literals (see the roster `team`-block incident above).
