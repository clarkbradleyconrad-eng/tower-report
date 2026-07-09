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
