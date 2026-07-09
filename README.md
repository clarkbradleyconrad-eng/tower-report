# tower-report
AI-powered Texas Longhorn sports intelligence platform

## Unified data layer — `data/db.json`

All static site data lives in one normalized store, `data/db.json`, with four collections. Every entity has a stable slug `id`, collections are objects keyed by those ids, and entities point at each other **by id only** — never by copied data. Pages fetch it client-side (directly or through the `js/tower-db.js` helper); no build step.

```
data/db.json
├─ schemaVersion, generatedAt, season
├─ teams:   { "texas": {…}, "ohio-state": {…}, … }
├─ players: { "arch-manning": {…}, "colin-simmons": {…}, … }
├─ games:   { "w1"…"w12" (2026 schedule), "vy-run-2006"… (historic) }
└─ stories: { "story-simmons-osu-2026": {…}, … }
```

### Entities and cross-references

| Collection | Key fields | References out |
|------------|-----------|----------------|
| `teams` | `id`, `name`, `abbr`, `logo` | — |
| `players` | `id` (slug), `name`, `number`, `position`, `posGroup`, `year`, bio/links/recruiting/stats/scout/draft blocks | `teamId → teams` |
| `games` | `id` (`w1`–`w12`, matching `/api/odds` keys; historic games keep their `game-story.html` ids), `dateISO`, `venue`, `type`, odds + analysis blocks; historic entries are lightweight (`era: "historic"`, `source`) | `opponentId → teams`, `playerIds[] → players`, `storyIds[] → stories` |
| `stories` | `id` (slug), `type` (`page` = static HTML article, `archive` = live Blob story addressed via `stories.html?story={slug}`), `title`, `url` | `playerIds[] → players`, `gameIds[] → games` |

So a story links to the players and game it covers (`stories["story-simmons-osu-2026"].playerIds = ["arch-manning","colin-simmons"]`, `.gameIds = ["w2"]`), and a game pulls its relevant stories (`games.w2.storyIds`). Reverse lookups (all stories for a player, all games for a player) are computed at load time by `js/tower-db.js` — the JSON stores each relationship once.

### Reading it

```html
<script src="js/tower-db.js" defer></script>
<script>
TowerDB.load().then(db => {
  db.playersArray                        // curated profiles, jersey order
  db.getGame('w2')                       // Ohio State, Sep 12
  db.getTeam(db.getGame('w2').opponentId)
  db.storiesForGame('w2')                // resolved story entities
  db.storiesForPlayer('colin-simmons')   // reverse ref
});
</script>
```

Server-side, `api/stories-refresh.js` reads the same file for Grok grounding (upcoming games).

### What stays outside `db.json`, and why

- **`data/roster.json`** — the full ~90-man roster, rewritten daily by the GitHub Actions bot. It stays a separate bot-owned feed so automation never rewrites the hand-curated store (see ARCHITECTURE.md invariants). `db.json.players` is the curated profile set; the raw roster is its upstream.
- **`data/depth-chart.json`** — positional projections, separate editorial cadence.
- **Runtime stories** (AI archive + newsroom CMS) — live in Vercel Blob, served by `/api/stories` and `/api/stories-db`; they are runtime data, not repo files. Their id conventions interoperate with the `stories` collection: `ai-{slug}` (AI archive), `story-{timestamp}-{rand}` (newsroom), `brief-{yyyymmdd}-{n}` (briefing items); AI stories carry `players[]` (names) and `tags[]` for entity matching, and any archive story can be referenced from `db.json` as a `type: "archive"` entry keyed by its `stories.html?story=` slug.

### Editing rules

1. Hand-edit `data/db.json` directly (it is the canonical copy — `data/players.json` and `data/schedule.json` were migrated into it and deleted 2026-07-08).
2. After any edit, run `node scripts/validate-db.mjs` — it fails on missing required fields or any id reference that doesn't resolve.
3. Add relationships by id in one direction where they're authored (e.g. a game's `storyIds`); use the loader's reverse helpers rather than duplicating arrays.

## Bot system — registry, orchestrator, ops

Every automated pipeline is a **bot** defined in [`bots/registry.json`](bots/registry.json) — id, purpose, schedule, prompt file, inputs, outputs, `dependsOn`, `enabled`, timeout, and alert rules. [`/api/orchestrator`](api/orchestrator.js) (Vercel crons 06:00/18:00 UTC + a 10:05 UTC GitHub Actions watchdog) resolves the order, runs each enabled bot with its own timeout, and isolates failures — one bot dying never blocks the rest. Every run logs per-bot status, duration, output summary, quality score (0–100, `bots/lib/score.js`; under 60 = rejected to the review queue), and the sha256 hash of the prompt file that produced the output, so quality changes trace to the exact prompt edit via `git log -p bots/prompts/{botId}.md`.

**Control room:** `ops.html?key={OPS_KEY}` (not linked in nav) — roster with 30-day quality sparklines, run timeline, review queue (rejected outputs + NEEDS-VERIFICATION items), social-draft review, enable/disable toggles, and single-bot / full-run / dry-run triggers. The alerts bot runs last every cycle and posts to Slack (`SLACK_OPS_WEBHOOK`) on failures, quality drops >15 points, missed morning runs, or a review queue over 10 items.

**Hard rule:** bots write only `data/*` (via the GitHub Actions roster bot) and Vercel Blob — never page HTML (see ARCHITECTURE.md).

### Adding a new bot — 3 steps

1. **Write its prompt**: copy [`bots/prompts/_template.md`](bots/prompts/_template.md) to `bots/prompts/{your-bot-id}.md`. The file is the system prompt; `{{FACTS}}` (hand-verified program facts) is injected automatically.
2. **Register it**: add an entry to `bots/registry.json` with `kind: "grok"`, your prompt file, `inputs` (e.g. `topStory`), an output blob (`blob:tower-{name}.json`), `dependsOn`, timeout, and alert rules.
3. **Deploy and run it**: `npx vercel deploy --prod`, then trigger it from ops.html (or `GET /api/orchestrator?bot={your-bot-id}&dryRun=true` first). It is now scheduled, scored, logged, and alertable like every other bot.

No orchestrator code changes needed — `kind: "grok"` bots run entirely from config (see `bots/lib/grokbot.js`). The `social-drafter` bot (top story → 3 X post drafts, surfaced on ops.html, never auto-posted) was added exactly this way as the reference example. Only bots wrapping bespoke `/api` endpoints (`kind: "http"`) need an adapter in `api/orchestrator.js`.
