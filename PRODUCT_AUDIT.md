# Tower Report — Product Audit (2026-07-22)

Repository-level audit before the clarity/trust rebuild. Companion docs: `ARCHITECTURE.md`
(content planes), `NEEDS-VERIFICATION.md` (quarantined claims), `AUDIT.md` (earlier pass).

## 1. Current technical structure

- Vanilla HTML/CSS/JS, no build step. ~20,500 lines of HTML across 28 pages; **zero shared
  CSS files** — every page carries its own inline `<style>` (~1,700 lines on index.html alone).
- Serverless functions in `/api` (12, Hobby cap). Bot pipeline (orchestrator + Grok bots) writes
  stories/briefing/recruiting-live to Vercel Blob. `data/*.json` is the git-committed plane.
- A shared data layer **already exists** (`data/db.json` + `js/tower-db.js` + `scripts/validate-db.mjs`)
  but only `players.html` uses it. Everything else hard-codes values.
- `nav.js` injects a shared nav on 17 pages; the 6 largest pages (index, schedule, stats,
  depth-chart, history, roster) each carry a *different* inline nav with different links.
- Stray `app/api/chat/route.ts` (Next.js remnant) never runs on this deployment but duplicates
  the chat system prompt with different facts; `@ai-sdk/xai` + `ai` deps exist only for it.

## 2. Main usability problems

- Homepage is ~9 screen-lengths and tries to be the whole product: full depth chart, stat-leader
  tables, 3 playoff-scenario cards, community board, roadmap, "how it works", waitlist.
- Waitlist CTA ("Be First In / The full platform is coming") on a fully public product; it is the
  nav's primary CTA on index.
- Navigation differs page to page (index has 8 links + waitlist; nav.js pages have 7 different ones).
- The AI — the flagship — is a small panel buried mid-hero with canned regex answers (`aiDB`),
  while the real streaming chat lives on intelligence.html.

## 3. Main visual problems

- 5 font families loaded (Playfair, Barlow, Barlow Condensed, Bebas Neue, Inter) — two Google
  CSS requests, heavy FOUT.
- Constant motion: 3+ permanently pulsing "LIVE" dots, blinking ticker, glow animations.
  No `prefers-reduced-motion` support.
- Inconsistent components: 4+ different card systems doing the same job with different markup.

## 4. Main performance problems

- Hero/背景 images are 1.5–2.4 MB PNGs (7 files, ~13.4 MB total in `img/`).
- No width/height on most images → CLS. No lazy loading. ESPN logo CDN calls per card.
- `background-attachment: fixed` on body (repaint cost on mobile), 70s infinite ticker animation.
- Inline CSS per page means zero cross-page cache reuse.

## 5. Data-integrity risks (worst first)

| Value | index.html | stats.html | Source of truth |
|---|---|---|---|
| Projected wins | **10.2** | **8.9** | none (Tower Model, static) |
| CFP probability | **72%** | **62%** | none |
| SEC title odds | **24%** | **31%** | none |
| Depth chart | Barron/Helm/Bond/Ford/Murphy (all **departed**) | — | `data/depth-chart.json` (Jun 2026) |
| DC | — (chat.js says **Muschamp**) | — | `data/facts.json`: **null / unverified** |
| 2027 targets | "Jalen Thompson, Marcus Williams…" (**invented**) | — | `data/recruiting.json` (verified) |

- **Fabricated content**: homepage "Hot on the Board" forum (invented usernames, reply/view
  counts), homepage 2027 recruiting radar (5 invented recruits), canned `aiDB` chat answers
  (invented NIL values, draft slots, AP preseason ranks), "+250 Heisman" & betting spreads
  hard-coded without source/retrieval time (a real odds pipeline exists: `/api/odds` + cache).
- **Fake liveness**: 3 hard-coded pulsing "LIVE" badges (masthead, hero, briefing) unconditionally
  animated whether or not data is fresh. Briefing blob last updated Jul 9 — 13 days stale — yet
  labeled LIVE.
- Roster facts in `api/chat.js` prompt partially contradict `data/depth-chart.json` and name an
  unverified DC.

## 6. Duplicated or contradictory content

- Program stats (972 wins, 4 titles, 51 NFL) repeated in 8+ hard-coded spots (source exists:
  `data/stats/program.json`).
- Schedule hard-coded in index.html `schedule2026` array AND `db.json.games` AND schedule.html.
- Two chat backends (`api/chat.js` live; `app/api/chat/route.ts` dead) with divergent prompts.
- Nav duplicated inline on 6 pages.

## 7. Broken / incomplete functionality

- `getAIResponse`/`aiDB` canned-answer path: dead weight after the real `/api/chat` wiring.
- Waitlist form posts nowhere meaningful. `img/stories/` is an empty directory.
- GitHub watchdog + CRON_SECRET issues tracked in NEEDS-VERIFICATION.md (ops, not UI).

## 8. Recommended architecture (kept: vanilla + Vercel; no framework migration)

1. **One source of truth**: extend `data/db.json` with `model` (season projections + metadata),
   `program` (from stats/program.json), `schedule` odds refs. All pages read via `TowerDB`
   selectors; no number typed twice.
2. **Shared shell**: `nav.js` → injects identical nav + footer + status strip everywhere;
   all 6 inline navs deleted.
3. **Shared design system**: `css/tower.css` — tokens (existing names preserved), badge/
   freshness/card/skeleton components, reduced-motion support.
4. **Homepage = command center** (~3 screens): nav → headline + Intelligence input →
   Today at Texas (real briefing w/ real freshness) → next game (odds w/ retrievedAt) →
   latest analysis → compact season outlook → section links.
5. **Intelligence = first-class page**: streaming, stop, retry, copy, suggested questions,
   `?q=` deep link, aria-live, honest "web search may have failed" states.
6. **Truth labels**: Verified / Reported / Projection / Tower Model / Developing chips; "LIVE"
   only when `/api/health` heartbeat is < freshness threshold; otherwise show "Updated Xh ago".

## 9. Ordered implementation plan

1. Centralize data (db.json `model`/`program`) + validate-db extension
2. `css/tower.css` tokens + components
3. `nav.js` unified shell on all pages
4. Rebuild index.html (remove fabricated content)
5. Rebuild intelligence.html UX; fix `api/chat.js` facts (DC null, roster from depth-chart.json)
6. Surgical fixes: stats/schedule/history model numbers → db.json; delete `app/`
7. Image compression (PNG→JPEG ≤ 250 KB) + dimensions + lazy loading
8. SEO (canonical/OG/robots/sitemap) + accessibility (skip link, focus, reduced motion)
9. QA: validate-db, link check, JS syntax check

## 10. Performance measurements

Before (local, static weights): img/ = 13.4 MB (largest page payload: index w/ hero-bg 2.1 MB
+ tower-bg 1.7 MB + texas-osu 1.9 MB ≈ 5.7 MB images alone); 5 font families; 3,844-line HTML.
After: recorded at bottom of this file post-implementation.

---

## Post-implementation results (2026-07-22)

- **Images**: `img/` 13.4 MB → **1.3 MB** (hero PNGs re-encoded to JPEG q58; 2 orphaned 3.6 MB
  files deleted). Homepage now ships no hero image at all — text-first above the fold.
- **Homepage**: 3,844 lines / 200 KB → **~340 lines / 22 KB**; 5 font families → 3; every number
  rendered from `db.json` / `/api/briefing` / `/api/stories` / `/api/odds` with freshness labels.
- **Data**: `db.json` gained `model` + `program` blocks; schedule.html hydrates model values from
  it; the 10.2-vs-8.9-vs-9.2 projected-wins and 72-vs-62 CFP contradictions are gone (canonical:
  8.9 wins, 62% CFP, 31% SEC, 14% title — the values stats/schedule already agreed on).
- **Removed fabrications**: fake community board (6 invented threads/usernames/counts), 5 invented
  2027 recruits, canned regex chat answers with invented NIL/draft/odds values, stale inline depth
  chart (5 departed players shown as starters), hard-coded LIVE badges (3), waitlist section,
  "Built Different"/"most capable model" marketing, unverified DC name in the chat system prompt,
  stray Next.js `app/` dir + 2 unused npm deps, Gunnar Helm listed as current TE on schedule.html.
- **Shell**: one nav (nav.js) on all pages — 7 sections + status strip fed by `/api/health`
  (renders nothing when unreachable; "delayed" past 13 h). Shared footer, skip link, focus
  styles, `prefers-reduced-motion`, escape-to-close mobile nav, 44 px targets.
- **QA**: `validate-db` passes; `node --check` clean on all first-party JS; local link scan clean;
  robots.txt + sitemap.xml (22 URLs) added; unique titles verified on all 26 pages.
- **Not measured**: Lighthouse/LCP/CLS require a deployed build — static weight and request-count
  reductions recorded here instead. Re-run Lighthouse after the next deploy.

## ⚠ Parallel-session note (2026-07-22 22:48 CT)

A concurrent editor session overwrote the rebuilt index.html mid-run with a patched copy of the
old homepage; that copy is preserved at the session scratchpad (`index-parallel-session-backup.html`)
and its unique fixes (viewport-fit, nav.js include, mobile input zoom) are incorporated here.
If the homepage regresses to the 3,800-line version, that session saved again — re-apply this one.
