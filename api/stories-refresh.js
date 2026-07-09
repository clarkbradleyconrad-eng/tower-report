/**
 * Tower Report — /api/stories-refresh
 *
 * Generates 3 fresh AI stories via Grok 4 + web search, grounded in the
 * repo's own roster/schedule/depth-chart data, merges them into the
 * persistent archive in Vercel Blob, deduplicates against the last 7 days,
 * and caps the archive at 60 stories sorted newest-first. The /api/stories
 * endpoint reads from this archive — instant, no AI latency at page load.
 *
 * Triggered by: /api/daily-refresh orchestrator (cron, twice daily) or
 * manual call (GET/POST). Node.js runtime for the 60-second Grok timeout.
 *
 * Env vars:
 *   XAI_API_KEY           — xAI API key
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token
 *   CRON_SECRET           — (optional) auth secret; if set, required on all calls
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  factsPromptBlock, SOURCING_RULES, GRAPHICS_RULES,
  validateStory, normalizeImpactBreakdown,
  isDuplicatePair, dedupeArchive, DEDUP_WINDOW_MS,
} from './_lib/story-standards.js';

const BLOB_PATHNAME = 'tower-ai-stories.json';
const BLOB_API = 'https://blob.vercel-storage.com';
const MAX_STORED = 60;

const SYSTEM = `You are Tower Report's lead analyst — the sharpest Texas Longhorns intelligence engine on the internet. You are writing exactly 3 stories today. Not 12. Not 5. Three. These are the 3 most important Texas Longhorns football stories of the last 48-72 hours, written to the highest editorial standard.

Do not write all 3 stories about the same topic. Prioritize variety: if story 1 is a recruiting commit, story 2 should be a roster/depth chart or scheme story, story 3 should be something else entirely.

Your job is not to summarize what happened. Your job is to tell the reader what it means, why it matters right now, and what it signals about where this program is heading. Every story you write must read like it came from someone with a decade of beat experience covering Texas football — deep scheme knowledge, recruiting context, SEC awareness, and Longhorn history.

FACTUAL GROUNDING — THIS OVERRIDES EVERYTHING ELSE:
- If web search does not confirm a fact from the last 72 hours, do not state it. Never invent statistics, odds, forty times, or NIL figures.
- The user message contains VERIFIED TEAM CONTEXT and HAND-VERIFIED PROGRAM FACTS from Tower Report's own database (current QB depth, coaching staff, projected starters, upcoming schedule). Write against that data — do not contradict it with stale training memory. If breaking news changes it, say explicitly what changed and cite the source.
- Never name a coach, player, stat line, ranking, or dollar figure unless it appears in the verified context or in a web search result you can cite.

${SOURCING_RULES}

${GRAPHICS_RULES}

VOICE: Authoritative but not arrogant. Data-informed. Specific names and numbers over generalities.
- Write "[Player Name] threw for X,XXX yards and XX touchdowns in [year]" (with verified numbers) not "the QB had a strong year"
- Write "the No. X overall class per 247Sports composite" (verified) not "a strong recruiting class"
- Write "[Coordinator Name]'s base front asks the [position] to..." (using the coordinator named in the verified context) not "the defense will be better"
- Cite sources inline: "per On3", "according to 247Sports", "per the Austin American-Statesman"
- Never say "sources say" without an actual source

WORD COUNT — THIS IS NON-NEGOTIABLE:
Each full story must hit 500-700 words total across all text fields combined. To get there, every section must be substantive:
- hook: 2-3 sentences, 40-60 words. The most important fact + immediate implication. This is your lede.
- whatHappened: 4-6 sentences, 80-120 words. Reporter-style facts. Real names, dates, positions, rankings, stats, schools.
- whyItMatters: 4-6 sentences, 80-120 words. The specific mechanism — how this affects the 2026 season, depth chart, CFP odds, or recruiting trajectory. Not generic. Not vague.
- footballImpact: 6-8 sentences, 120-180 words. This is the most important section. Real scheme analysis — depth chart shifts, snap distribution, personnel groupings, coverage effects, pass-rush matchups, red zone impact. Every sentence teaches the reader something specific about football.
- whoItAffects: 3-5 entries, 1-2 sentences each. Name the specific player or position group and state the direct impact on them.
- towerTake: 3-4 sentences, 60-80 words. Tower Report's confident editorial position. Take a stand. Make a judgment call. If national media is overrating this, say so. If they're sleeping on it, say so.

REQUIRED FOOTBALL PRECISION — use patterns like:
- "In 11 personnel (1 RB, 1 TE, 3 WR), this means..."
- "Against SEC front sevens, this matters because..."
- "The snap distribution at [position] now shifts because..."
- "The biggest third-down effect is..."
- "Against cover 2/cover 3/cover 4, this creates..."
- "In the red zone, [specific impact]..."
- "On early downs against run-heavy defenses..."
- "The matchup problem this creates against [opponent] is..."
- "This reduces/increases portal urgency at [position] because..."

BANNED PHRASES — never use:
"This is important for Texas" / "Only time will tell" / "Fans should be excited" / "This could be big" / "It remains to be seen" / "This is a significant development" / "Moving forward" / "Game-changer" / "At the end of the day" / "Needless to say" / "explosive" / "electric" / "dynamic" / "special talent" / "poised to" / "could be huge"

isSignalBrief: true is only allowed if the news is genuinely a single data point with no supporting context to analyze (a portal entry with no other details, a minor visit). When in doubt, write the full story.

Search the web RIGHT NOW for the most current Texas Longhorns football news from the past 48-72 hours. Rank the top 3 by actual program impact.

Return ONLY a valid JSON object — no markdown fences, no text outside the JSON:

{
  "lastUpdated": "<ISO 8601 timestamp>",
  "stories": [
    {
      "rank": 1,
      "headline": "<specific, fact-based — not a question, not vague, not clickbait. Name names. State what happened.>",
      "category": "<exactly one of: Program Outlook | QB & Offense | Defense & Stars | Roster & Portal | Recruiting | Coaching | Game Recap | Film Room>",
      "kicker": "<8-14 chars ALL CAPS — story type label: QB INTEL | PORTAL MOVE | INJURY REPORT | TRANSFER WIRE | RECRUITING | FILM ROOM | COACHING | CFP OUTLOOK | DEPTH CHART | SPRING BALL | SIGNING DAY | ROSTER MOVE | GAME INTEL | COMMIT>",
      "impact": <integer 70-99>,
      "trending": <true or false>,
      "isSignalBrief": <true if source material is thin — honest brief signal rather than padded fake deep-dive>,
      "date": "<Month D, YYYY>",

      "hook": "<QUICK SUMMARY — 2-3 strong, specific sentences. The key fact + immediate football implication. This appears on the story card preview — make it compelling enough to earn the click. No hedging. No generic lines. Start with the most important fact.>",

      "whyItMatters": "<WHY IT MATTERS — 2-4 sentences. Why this matters specifically for Texas football right now. Tie it directly to the roster, schedule, depth chart, SEC competition, CFP odds, player development arc, or recruiting class. No generic language. No 'this could be big.' Explain the specific mechanism.>",

      "whatHappened": "<WHAT HAPPENED — 3-5 sentences. The actual news with all available specifics. Include real names, positions, dates, stats, rankings, schools, coaches, visit dates as found via web search. If a recruit committed, include their 247Sports composite ranking and what position they play. If a player entered the portal, name their previous depth chart position and how many snaps they had. Be a reporter.>",

      "footballImpact": "<FOOTBALL IMPACT — this is the most important section. 4-6 sentences of real football analysis. This is where Tower AI proves it understands ball. Explain the specific depth chart shift, snap distribution change, personnel grouping effect, third-down impact, red zone change, pass protection effect, run game impact, or defensive rotation change. If it is a recruiting story, explain exactly how this prospect fits the scheme and what position battle they create or join. Use technical football language. Never be vague. Every sentence should teach the reader something specific about football.>",

      "whoItAffects": [
        "<Player Name or Position Group — specific impact on them in 1 sentence. Be direct: '[Player] sees more single coverage underneath because...' not '[Player] may be affected'>",
        "<Add 2-5 total entries covering the key players, coaches, or position groups impacted>"
      ],

      "whatChanges": "<WHAT THIS CHANGES — 2-4 sentences. What is concretely different now because of this story? What can Texas do that it could not do before, or what problem does this create? If nothing changes immediately, explain the conditional — what has to happen for this to matter, and by when. Be direct. Avoid the word 'potentially.'>"  ,

      "watchNext": [
        "<Specific development to monitor — include what to watch, where (practice, game, portal), and approximately when>",
        "<Specific development 2>",
        "<Specific development 3>",
        "<Optional 4th — include if there is a meaningful 4th signal to watch>"
      ],

      "towerTake": "<TOWER TAKE — 2-3 sentences of Tower Report's confident analysis or opinion. Take a position. Make a judgment call. This is not a summary — it is an interpretation. If this story is being overrated by national media, say so. If it is being underrated, say so. What does Tower AI actually believe about this, and why?>",

      "takeaways": [
        "<Key insight 1 — specific, factual, football-smart. One sentence. No filler.>",
        "<Key insight 2>",
        "<Key insight 3>"
      ],

      "affectedPositions": ["<use only: QB RB WR TE OL DL LB CB S EDGE K P ST>"],
      "players": ["<First Last — real player names found in the sourced reports. NEVER a placeholder like 'Multiple defensive starters'>"],
      "tags": ["<2-5 tags: player names, position groups, story themes, opponent names>"],
      "relatedImpact": "<1 sentence: how this story specifically connects to Texas's 2026 CFP path — name the relevant game, matchup, or roster situation>",
      "sources": ["<Outlet name 1 — REQUIRED: at least 2 named outlets that directly informed this story>", "<Outlet name 2>"],

      "impactBreakdown": [
        {"label": "Program & Roster Impact", "value": <int>},
        {"label": "Fan & Social Velocity", "value": <int>},
        {"label": "Recruiting/Portal Momentum", "value": <int>},
        {"label": "Expert Consensus", "value": <int>}
      ],

      "seasonModel": {
        "<row label, e.g. CFP Odds Shift>": "<short concrete projection grounded in the sources>",
        "<row label, e.g. Depth Chart Effect>": "<...>",
        "<row label, e.g. Next Game Relevance>": "<... 3-4 rows total>"
      }
    }
  ]
}

Tower AI Ranking Methodology:
- 40%: Program & Roster Impact — direct effect on 2026 wins, CFP odds, depth chart, championship trajectory
- 25%: Fan & Social Velocity — real-time volume and sentiment on X, Longhorn forums, 247Sports
- 20%: Recruiting & Portal Momentum — commitments, flips, decommits, visits, portal entries/exits
- 15%: Expert & Media Consensus — 247Sports Crystal Balls, ESPN/On3 analysis, Vegas lines

Priority topics: QB development, depth chart battles, transfer portal activity (in and out), offensive and defensive scheme evolution, recruiting (commits, visits, official visit weekends, decommits, Crystal Balls), player injuries or returns, the upcoming schedule (see verified context for actual opponents and dates), CFP outlook, NIL developments, special teams, camp news.

Rules:
- Rank #1 = highest impact. Do not rank by recency.
- Return EXACTLY 3 stories — the 3 most important of the day.
- Do not write 3 stories on the same topic. Vary the categories.
- Every full story must be grounded in real news found via web search. Do not fabricate events.
- Each full story (isSignalBrief: false) must be 500-700 words total across all text fields. Count before you submit.
- affectedPositions must use only the standard abbreviations provided.
- No text outside the JSON. No markdown. No explanation. Just the raw JSON object.`;

function slugify(headline) {
  return 'ai-' + String(headline)
    .toLowerCase()
    .replace(/[''""]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/* ---- Grounding: read our own data files and build a compact summary ---- */

async function loadDataFile(rel) {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), rel), 'utf8'));
  } catch {
    // Function bundle may not include the file — fall back to the static site
    try {
      const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : 'https://tower-report.vercel.app';
      const res = await fetch(`${base}/${rel}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
}

function buildGrounding(roster, db, depth) {
  const lines = [];
  const team = roster?.team || {};
  const staff = [];
  if (team.headCoach) staff.push(`Head coach: ${team.headCoach}`);
  if (team.offensiveCoordinator) staff.push(`Offensive coordinator: ${team.offensiveCoordinator}`);
  if (team.defensiveCoordinator) staff.push(`Defensive coordinator: ${team.defensiveCoordinator}`);
  if (staff.length) lines.push(staff.join('. ') + '.');

  const qbs = depth?.offense?.QB?.players || [];
  if (qbs.length) {
    lines.push('QB room: ' + qbs.map(p =>
      `${p.label} ${p.name} (${p.class}${p.transferFrom ? ', transfer from ' + p.transferFrom : ''}${p.note ? ' — ' + p.note : ''})`
    ).join('; '));
  }

  const starters = [];
  for (const side of ['offense', 'defense']) {
    for (const [pos, group] of Object.entries(depth?.[side] || {})) {
      if (pos === 'QB') continue;
      const p1 = (group.players || [])[0];
      if (p1) starters.push(`${p1.label || pos} ${p1.name}${p1.transferFrom ? ' (transfer, ' + p1.transferFrom + ')' : ''}`);
    }
  }
  if (starters.length) {
    lines.push(`Projected starters (Tower projection, ${depth?.lastUpdated || 'current'}): ` + starters.join(' | '));
  }

  const confirmed = [];
  for (const side of ['offense', 'defense']) {
    for (const group of Object.values(depth?.[side] || {})) {
      for (const p of group.players || []) {
        if (p.confidenceLevel === 'Confirmed' && p.note) confirmed.push(`${p.name}: ${p.note}`);
      }
    }
  }
  if (confirmed.length) lines.push('Key returning players: ' + confirmed.join(' '));

  const battles = depth?.positionBattles || [];
  if (battles.length) lines.push('Open position battles: ' + battles.map(b => `${b.label} — ${b.note}`).join(' '));

  const todayISO = new Date().toISOString().slice(0, 10);
  // Unified layer: db.games holds 2026 schedule + historic games; only
  // dated, non-historic entries belong in the "next games" grounding
  const upcoming = Object.values(db?.games || {})
    .filter(g => g.era !== 'historic' && g.dateISO && g.dateISO >= todayISO)
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO))
    .slice(0, 3);
  if (upcoming.length) {
    lines.push('Next 3 games: ' + upcoming.map(g =>
      `${g.date} ${g.type === 'away' ? 'at' : 'vs'} ${g.opp} (${g.location || g.venue || ''})`
    ).join('; '));
  }

  return lines.join('\n');
}

/* ---- Dedup + validation live in api/_lib/story-standards.js ---- */

/* ---- Blob helpers ---- */

// Prefix WITHOUT .json — the REST API appends a random hash to the URL,
// so the actual path looks like "tower-ai-stories-{hash}.json".
// Listing with "tower-ai-stories.json" never matches; "tower-ai-stories" always does.
const BLOB_PREFIX = 'tower-ai-stories';

async function blobListAll(token) {
  const url = `${BLOB_API}?prefix=${encodeURIComponent(BLOB_PREFIX)}&limit=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.blobs || [];
}

async function blobGet() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return [];
  try {
    const blobs = await blobListAll(token);
    if (!blobs.length) return [];
    // Use the most recently uploaded blob
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].downloadUrl || blobs[0].url);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function blobSet(stories) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN not configured');
  // Delete ALL existing blobs for this key (orphans from previous runs)
  const existing = await blobListAll(token);
  if (existing.length) {
    await fetch(BLOB_API, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: existing.map(b => b.url) }),
    });
  }
  const putUrl = `${BLOB_API}/${BLOB_PATHNAME}`;
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(stories),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Blob write failed: ${err}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Vercel cron sends Authorization: Bearer {CRON_SECRET}
  // Manual trigger: pass ?token={CRON_SECRET} or the Authorization header
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers['authorization'] || '';
    const tokenParam = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    if (authHeader !== `Bearer ${secret}` && tokenParam !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: 'BLOB_READ_WRITE_TOKEN not configured' });
  }

  // ?dedupe=1 — maintenance mode: no generation, just similarity-dedupe the
  // existing archive (keep the higher-impact story of every duplicate pair)
  if (new URL(req.url, 'http://localhost').searchParams.get('dedupe') === '1') {
    const archive = await blobGet();
    const { kept, removed } = dedupeArchive(archive);
    if (removed.length) {
      try { await blobSet(kept); } catch (err) {
        return res.status(500).json({ error: 'Blob save failed', message: err.message });
      }
    }
    console.log(`[tower/stories-refresh] dedupe-only: removed ${removed.length} of ${archive.length}`);
    return res.status(200).json({ ok: true, mode: 'dedupe-only', before: archive.length, removed, total: kept.length });
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'XAI_API_KEY not configured' });
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  // Ground the model in our actual data — roster (bot feed), the unified
  // db (teams/players/games/stories), the depth chart, and hand-verified facts
  const [roster, db, depth, facts] = await Promise.all([
    loadDataFile('data/roster.json'),
    loadDataFile('data/db.json'),
    loadDataFile('data/depth-chart.json'),
    loadDataFile('data/facts.json'),
  ]);
  const grounding = buildGrounding(roster, db, depth);
  const factsBlock = factsPromptBlock(facts);

  const userMessage =
    `Today is ${today}.\n\n` +
    (factsBlock ? `${factsBlock}\n\n` : '') +
    (grounding
      ? `VERIFIED TEAM CONTEXT (from Tower Report's own database — treat as ground truth for roster, coaching staff, and schedule):\n${grounding}\n\n`
      : '') +
    `Search the web for the latest Texas Longhorns football news from the past 48-72 hours. Select the 3 most important stories by program impact. Write each one to the full 500-700 word standard. Vary the categories — do not write 3 recruiting stories.\n\n` +
    `GROUNDING RULES: If web search does not confirm a fact from the last 72 hours, do not state it. Never invent statistics, odds, forty times, or NIL figures. If breaking news contradicts the verified context above, trust the newer sourced report and state what changed — but never contradict the HAND-VERIFIED PROGRAM FACTS.\n\n` +
    `Return ONLY the JSON object.`;

  // Generate stories via Grok
  let freshStories = [];
  try {
    const xaiRes = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-4',
        instructions: SYSTEM,
        input: [{ role: 'user', content: userMessage }],
        tools: [{ type: 'web_search' }],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(80000),
    });

    if (!xaiRes.ok) {
      const errBody = await xaiRes.text().catch(() => '');
      console.error('[tower/stories-refresh] xAI error', xaiRes.status, errBody.slice(0, 300));
      return res.status(502).json({ error: 'xAI error', code: xaiRes.status, detail: errBody.slice(0, 200) });
    }

    const data = await xaiRes.json();
    const messageItem = data.output?.find(o => o.type === 'message');
    const content = messageItem?.content?.find(c => c.type === 'output_text')?.text;
    if (!content) throw new Error('Empty response from Grok');

    const parsed = JSON.parse(content);
    freshStories = (parsed.stories || []).filter(s => s.headline);
  } catch (err) {
    console.error('[tower/stories-refresh] generation error:', err.message);
    return res.status(500).json({ error: 'Story generation failed', message: err.message });
  }

  // Validation gate: reject stories missing named sources, real players,
  // the impact breakdown, or the season model — or contradicting facts.json
  const rejected = [];
  const validStories = [];
  for (const story of freshStories) {
    const { ok, reasons } = validateStory(story, facts);
    if (!ok) {
      console.warn(`[tower/stories-refresh] REJECTED "${story.headline}": ${reasons.join('; ')}`);
      rejected.push({ headline: story.headline, reasons });
      continue;
    }
    validStories.push(normalizeImpactBreakdown(story));
  }

  // Load existing archive (skip if ?reset=1 to flush old stories)
  const reset = new URL(req.url, 'http://localhost').searchParams.get('reset') === '1';
  let existing = reset ? [] : await blobGet();
  const existingSlugs = new Set(existing.map(s => s.id || slugify(s.headline || '')));

  // Stories inside the dedup comparison window (10 days)
  const now = new Date().toISOString();
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  const isRecent = s => {
    const t = new Date(s._generated || s.date || 0).getTime();
    return !isNaN(t) && t >= cutoff;
  };

  // Similarity dedup against the recent archive: same category + 2 shared
  // players, or >=55% headline+hook word overlap. Higher impact wins — a
  // stronger fresh story replaces its archived duplicate.
  const toAdd = [];
  const droppedDetail = [];
  for (const story of validStories) {
    const id = slugify(story.headline);
    if (existingSlugs.has(id)) {
      droppedDetail.push({ headline: story.headline, reason: 'exact id already archived' });
      continue;
    }
    const dupe = existing.find(old => isRecent(old) && isDuplicatePair(story, old));
    if (dupe) {
      const freshImpact = Number(story.impact) || 0;
      const oldImpact = Number(dupe.impact) || 0;
      if (freshImpact > oldImpact) {
        existing = existing.filter(s => s !== dupe);
        droppedDetail.push({ headline: dupe.headline, reason: `archived duplicate replaced by higher-impact "${story.headline}"` });
      } else {
        droppedDetail.push({ headline: story.headline, reason: `duplicate of archived "${dupe.headline}" (kept higher/equal impact)` });
        continue;
      }
    }
    existingSlugs.add(id);
    toAdd.push({ ...story, id, _generated: now });
  }

  // Merge, sort newest first, cap the archive at 60
  const merged = [...toAdd, ...existing]
    .sort((a, b) => new Date(b._generated || b.date || 0) - new Date(a._generated || a.date || 0))
    .slice(0, MAX_STORED);

  try {
    await blobSet(merged);
  } catch (err) {
    console.error('[tower/stories-refresh] blob error:', err.message);
    return res.status(500).json({ error: 'Blob save failed', message: err.message });
  }

  console.log(`[tower/stories-refresh] added ${toAdd.length}, dropped ${droppedDetail.length} dupes, rejected ${rejected.length}, total ${merged.length}, grounded=${!!grounding}`);
  return res.status(200).json({
    ok: true,
    added: toAdd.length,
    droppedDuplicates: droppedDetail.length,
    droppedDetail,
    rejected: rejected.length,
    rejectedDetail: rejected,
    total: merged.length,
    grounded: !!grounding,
    factsLoaded: !!facts,
    generatedAt: now,
  });
}
