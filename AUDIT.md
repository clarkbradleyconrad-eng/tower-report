# Tower Report — Repo Audit

**Date:** July 8, 2026 · **Scope:** all HTML pages, all `/api` functions, cron config, Supabase queries, GitHub Actions, data files.
**Method:** static read of every API file and page wiring, cross-reference of every `fetch()` endpoint and local `href`/`src`, plus live probes of production (`/api/health`, `/api/briefing`, `/api/stories`, `/api/odds`).

**Live-state snapshot at audit time:** briefing and stories archives were refreshed 2026-07-08 ~05:20 UTC (healthy), odds serving placeholder data (`ODDS_API_KEY` not set), `/api/health` returns 404 in production because the new pipeline files are not deployed yet.

Severity scale: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low

---

## 🔴 C1. The new cron pipeline exists only on this machine — production is running the old, over-limit config

`api/daily-refresh.js`, `api/health.js`, `api/tiktok-drafts.js`, `desk.html`, and `supabase/tiktok_drafts.sql` are **untracked**, and `vercel.json`, `api/stories.js`, `api/story.js`, `api/stories-refresh.js`, `data/roster.json`, `index.html` have **uncommitted edits**. Production therefore still runs the old `vercel.json` with **4 cron entries — double the Hobby-plan limit of 2** (the exact problem the daily-refresh orchestrator was written to solve). Observable consequences right now:

- `GET /api/health` → 404 in production, so the "Pipeline last run" heartbeat in stories.html silently never renders (it has a `.catch(){}`).
- `/desk` (Content Desk) does not exist in production.
- Today's data refresh timestamps (05:19:57 and 05:20:12 UTC) don't match any configured cron time — consistent with manual triggering, i.e. the scheduled pipeline is not what's keeping the site fresh.

**Fix:** not a code change — commit and deploy the migration, and before/at deploy:
1. Run `supabase/tiktok_drafts.sql` in the Supabase SQL editor (once).
2. Set env vars in Vercel: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DESK_PASSWORD`, and (recommended, see H1/H2) `CRON_SECRET`.
3. Confirm the project has Fluid Compute enabled — `maxDuration: 300` for `daily-refresh` is only valid on Hobby with Fluid Compute; without it the function is killed at 60s, mid-pipeline.

*Left for you — I don't commit/deploy without a go-ahead.*

## 🟠 H1. `/api/stories-db` is completely unauthenticated — anyone can publish, edit, or delete site content

`api/stories-db.js` accepts `POST`/`PATCH`/`DELETE` from anyone on the internet with CORS `*`. Combined with `newsroom.html` having no gate, any visitor who discovers the endpoint can deface the public stories feed, delete every newsroom story, or flood the blob. (Rendering is escaped in both stories.html and /api/story, so this is defacement/deletion, not XSS.) `/api/generate-story` is likewise an unauthenticated `POST` that triggers a paid Grok-4 + web-search call — an open cost-abuse vector.

**Fix (applied, see fix log):** mutations on `stories-db` and calls to `generate-story` now require `X-Desk-Key: {DESK_PASSWORD}` or `Bearer {CRON_SECRET}` **when those env vars are set** (fail-open when unset, so nothing breaks before env configuration). `daily-refresh` passes the secret on its internal calls; `newsroom.html` sends the same stored desk key `desk.html` uses and prompts for it on 401.

## 🟠 H2. Unauthenticated cron triggers burn paid AI calls

`GET /api/briefing?cron=1` and `GET /api/tiktok-drafts?cron=1` trigger Grok-4 (with web search) for anyone who requests them — no secret required. Each hit costs real money, and briefing?cron=1 also overwrites the cached briefing blob (a hostile actor could hammer it to exhaust the xAI budget or keep churning the homepage briefing).

**Fix (applied):** both cron paths honor `CRON_SECRET` when set (via `?token=` or `Authorization: Bearer`), fail-open when unset; `daily-refresh` forwards the secret.

## 🟠 H3. Tomorrow's roster bot run will silently wipe the coordinator fields the story pipeline depends on

The uncommitted `data/roster.json` adds `offensiveCoordinator` / `defensiveCoordinator`, and the new `stories-refresh.js` grounding block feeds them to Grok as verified truth. But `.github/scripts/update_roster.py` (runs daily at 06:00 UTC, actively committing — see bot commits) rebuilds the `team` object from a hardcoded literal containing only `name`/`conference`/`headCoach`. The next successful run deletes both coordinator fields; grounding degrades silently (it conditionally skips missing fields, so nothing errors).

**Fix (applied):** `build_roster_json` now merges the freshly-scraped data over the existing file's `team` block instead of replacing it.

## 🟡 M1. Homepage briefing shows fabricated timestamps

`index.html` `loadBriefing()` stamps items with `timeOffsets=[1,2,3,5,7]` → every visitor always sees "1h ago / 2h ago / 3h ago / 5h ago / 7h ago" regardless of reality. If the pipeline stalls for a week, the homepage still claims hour-old intel. Same class of fake-freshness the uncommitted `stories.js` edit already removed (`totalSignals: 847 + n*12`, still live in prod today returning `totalSignals: 1027`).

**Fix (applied):** item age now derives from the briefing's real `lastUpdated`; same markup, same styling.

## 🟡 M2. Cron paths carry a dead `?slot=` query param

Both crons point at `/api/daily-refresh?slot=am|pm`, but `daily-refresh.js` never reads `slot`. Vercel's documented cron patterns use plain paths (parameterization via path segments); a query string here is at best dead weight and at worst a validation/compat hazard. Bonus bug: `daily-refresh`'s `trigger:` label only detects cron runs via an auth header or a `cron` query param — with no `CRON_SECRET` set, real cron runs are logged as `"manual"`.

**Fix (applied):** query strings removed from `vercel.json` cron paths; cron detection now also checks Vercel's `x-vercel-cron` header / `vercel-cron` user-agent.

## 🟡 M3. Heartbeat falsely marks the stories-refresh step failed when it runs long

`daily-refresh` aborts every step fetch at 58s (`STEP_TIMEOUT_MS`), but `stories-refresh` is allotted `maxDuration: 90` and can legitimately take ~55s of Grok + blob round-trips — i.e. it can finish successfully *after* the orchestrator gave up, so the heartbeat logs a failure for a step that succeeded (and the health footer on stories.html would report a false "failed steps: stories-refresh").

**Fix (applied):** the stories-refresh step gets an 88s timeout matched to its `maxDuration`; other steps keep 58s.

## 🟡 M4. Supabase status update can silently no-op

`sbSetStatus` in `api/tiktok-drafts.js`: PostgREST returns `200` + `[]` when the `id=eq.{id}` filter matches zero rows, so marking a deleted/foreign draft "posted" reports success and the desk UI flips the pill even though nothing was written. This was the main "fails silently" candidate in the Supabase layer (reads and upserts both check `res.ok` and the table's `unique (date, option_label)` matches the upsert's `on_conflict` — those are sound).

**Fix (applied):** throws `Draft not found` when the PATCH representation comes back empty.

## 🟡 M5. GitHub Actions burns daily Anthropic credits generating files nothing reads

`update-roster.yml` runs `aggregate_news.py` and `generate_stories.py` every day with `ANTHROPIC_API_KEY`, committing `data/briefing.json`, `data/stories.json`, `data/story-queue.json`. **No page or API reads any of them** — the live site sources briefing/stories exclusively from Vercel Blob via `/api/briefing` and `/api/stories` (verified by grepping every `fetch()` in the repo). This is a leftover parallel pipeline from before the Grok/Blob architecture: paid API calls + a bot commit + a Vercel deploy every day, for output with zero consumers.

**Fix (applied):** removed the two AI steps from the workflow (roster scrape + commit kept). The Python scripts stay in `.github/scripts/` in case you want them back.

## ⚪ L1. Blob token leaked into request URL

`api/briefing.js` `blobListAll()` puts the read-write token in the query string (`&token=...`) *and* the Authorization header. Query strings end up in logs/traces. **Fix (applied):** header only, matching every other blob helper in the repo.

## ⚪ L2. `/story?id=` renders unpublished newsroom drafts

`api/story.js` looks up newsroom stories without checking `status`, so auto-generated drafts are publicly renderable to anyone with the id (ids are unguessable timestamps, hence Low). **Fix (applied):** newsroom stories must be `status: 'published'` to render; AI-archive stories unaffected.

## ⚪ L3. `update-roster.html` has malformed HTML

Stray text nodes: `<title>Roster  Tower Report</title>Editor` and `<h1>Tower  Roster Editor</h1>Report` — "Editor"/"Report" render as loose page text. Page is also superseded by the roster GitHub Action and writes a root-level `roster.json` that nothing consumes (root `roster.json`, stale since Jun 2, is a dead file — the site reads `data/roster.json`). **Fix (applied):** corrected the broken title/heading markup; left the page and dead file in place (flagging for deletion is your call).

## ⚪ L4. Repo/deploy hygiene: `node_modules` (2,296 files) and `schedule.html.bak` are committed

`.gitignore` only ignores `.vercel`, so all of `node_modules/` is tracked and — because this deploys as a static site — **served publicly**, as is `schedule.html.bak` (an old full copy of the schedule page a crawler can index). **Fix (applied):** `node_modules/` added to `.gitignore` and untracked; `schedule.html.bak` deleted (recoverable from git history).

## ⚪ L5. Dead Next.js route with a conflicting knowledge base

`app/api/chat/route.ts` is a Next.js App Router file in a project with no Next.js — it never deploys (the live chat is `api/chat.js`). Its embedded knowledge base is also stale/contradictory (missing games, "Heisman favorite" vs. the live prompt's roster detail). The `package.json` deps `@ai-sdk/xai` + `ai` exist solely for this dead file. **Flag only** — recommend deleting `app/` and the two deps; left in place since it's inert.

---

## Flagged, not fixed (needs your decision or is data/copy, not code)

| # | Item | Why it's flagged |
|---|------|------------------|
| F1 | **Waitlist form stores nothing** (`index.html` `joinWL()`) — shows "✓ You're on the list" and discards the email. | Real users are being silently dropped. Needs a storage decision (a `waitlist` Supabase table + tiny endpoint would fit the existing stack). |
| F2 | **Edge functions await Grok for up to 55s** (`briefing`, `generate-story`, `tiktok-drafts`, all `runtime:'edge'`). | Works in production today, but long non-streaming waits on edge runtime are the first suspect if cron steps start timing out; moving them to the Node runtime is the safe long-term shape. |
| F3 | **Depth chart data is a month stale** — `data/depth-chart.json` `lastUpdated: 2026-06-03`, echoed by hardcoded "Last Updated June 3, 2026" on depth-chart.html and "as of June 2026" copy on recruiting.html. | The stories-refresh grounding feeds this to Grok as "ground truth." Accurate labels, stale data — needs an editorial refresh, not code. |
| F4 | **`ODDS_API_KEY` unset in production** — `/api/odds` serves June 3 placeholder lines; schedule page correctly badges them "Pre-Season." | Set the env var when you want live lines; fallback behavior is working as designed. |
| F5 | **stats.html** section label "methodology coming soon". | Placeholder copy; designer-controlled area so left alone. |
| F6 | `roster.json` (repo root) and `update-roster.html` are a dead manual-update path. | Superseded by the GitHub Action; safe to delete both when ready. |

**Verified clean:** every local `href`/`src` across all 25 HTML pages resolves (the only "misses" were JS template literals); all history.html → game-story.html deep links match ids in `js/game-data.js`; nav/footer cross-links valid; `/api/chat` SSE format matches the intelligence.html/schedule.html client parsers; stories.html deep links (`?story=` and `/story?id=`) wired correctly end-to-end; Supabase schema matches the upsert's `on_conflict` contract; blob read/write/orphan-cleanup pattern is consistent across all five blob consumers.
