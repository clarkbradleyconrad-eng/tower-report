/**
 * Tower Report — /api/stories-refresh
 *
 * Generates 3 fresh AI stories via Grok 4 + web search, grounded in the
 * repo's own roster/schedule/depth-chart data, merges them into the
 * persistent archive in Vercel Blob, deduplicates against the last 7 days,
 * and caps the archive at 60 stories sorted newest-first. The /api/stories
 * endpoint reads from this archive — instant, no AI latency at page load.
 *
 * Triggered by: /api/orchestrator (cron, twice daily; see bots/registry.json)
 * or manual call (GET/POST). Node.js runtime for the long Grok timeout.
 *
 * Env vars:
 *   XAI_API_KEY           — xAI API key
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token
 *   CRON_SECRET           — (optional) auth secret; if set, required on all calls
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validateStory, normalizeImpactBreakdown,
  isDuplicatePair, dedupeArchive, DEDUP_WINDOW_MS,
} from './_lib/story-standards.js';
import { loadPromptWithFacts } from '../bots/lib/prompts.js';
import { scoreStory, REJECT_THRESHOLD } from '../bots/lib/score.js';
import { pushRejected } from '../bots/lib/blob.js';

const BLOB_PATHNAME = 'tower-ai-stories.json';
const BLOB_API = 'https://blob.vercel-storage.com';
const MAX_STORED = 60;

/* System prompt lives in bots/prompts/stories-refresh.md (versioned; its
   hash is logged with every output so quality changes trace to prompt edits
   via `git log -p bots/prompts/stories-refresh.md`). */

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

  // Versioned system prompt with the facts block injected ({{FACTS}} token)
  let SYSTEM, promptHash;
  try {
    ({ text: SYSTEM, hash: promptHash } = await loadPromptWithFacts('stories-refresh', facts));
  } catch (err) {
    return res.status(503).json({ error: 'Prompt load failed', message: err.message });
  }

  const userMessage =
    `Today is ${today}.\n\n` +
    (grounding
      ? `VERIFIED TEAM CONTEXT (from Tower Report's own database — treat as ground truth for roster, coaching staff, and schedule):\n${grounding}\n\n`
      : '') +
    `Search the web for the latest Texas Longhorns football news from the past 48-72 hours. Select the 2 most important stories by program impact. Write each one to the full 900-1,300 word elite-analysis standard — every section budget, the second-order effects chain, the opponent-specific application, the roster math, the historical precedent, the contrarian angle, and the falsifiable prediction. Vary the categories — do not write 2 recruiting stories.\n\n` +
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

  // ?dryRun=1 (orchestrator dry runs): full generation + validation +
  // scoring, but nothing is published and nothing lands in the queues
  const dryRun = new URL(req.url, 'http://localhost').searchParams.get('dryRun') === '1';

  // Two gates before publication:
  //   1. hard validation (sources, players, breakdown, facts conflicts)
  //   2. quality score 0-100 (bots/lib/score.js) — below REJECT_THRESHOLD
  //      the story goes to the review queue instead of the public feed
  const rejected = [];
  const validStories = [];
  const storyScores = [];
  for (const story of freshStories) {
    const { ok, reasons } = validateStory(story, facts);
    if (!ok) {
      console.warn(`[tower/stories-refresh] REJECTED "${story.headline}": ${reasons.join('; ')}`);
      rejected.push({ headline: story.headline, reasons, score: null, story });
      continue;
    }
    normalizeImpactBreakdown(story);
    const graded = scoreStory(story, facts);
    if (graded.score < REJECT_THRESHOLD) {
      console.warn(`[tower/stories-refresh] LOW SCORE ${graded.score} "${story.headline}": ${graded.reasons.join('; ')}`);
      rejected.push({ headline: story.headline, reasons: graded.reasons, score: graded.score, story });
      continue;
    }
    story._score = graded.score;
    storyScores.push(graded.score);
    validStories.push(story);
  }

  // Rejections land in the per-bot review queue (blob), capped at 50
  if (rejected.length && !dryRun) {
    try {
      for (const r of rejected) {
        await pushRejected('stories-refresh', {
          promptHash, score: r.score, reasons: r.reasons, output: r.story,
        });
      }
    } catch (err) {
      console.warn('[tower/stories-refresh] rejected-queue write failed:', err.message);
    }
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

  if (!dryRun) {
    try {
      await blobSet(merged);
    } catch (err) {
      console.error('[tower/stories-refresh] blob error:', err.message);
      return res.status(500).json({ error: 'Blob save failed', message: err.message });
    }
  }

  const avgScore = storyScores.length
    ? Math.round(storyScores.reduce((a, b) => a + b, 0) / storyScores.length)
    : 0;
  console.log(`[tower/stories-refresh] added ${toAdd.length}, dropped ${droppedDetail.length} dupes, rejected ${rejected.length}, total ${merged.length}, score=${avgScore}, prompt=${promptHash}, dryRun=${dryRun}`);
  return res.status(200).json({
    ok: true,
    ...(dryRun ? { dryRun: true } : {}),
    added: toAdd.length,
    droppedDuplicates: droppedDetail.length,
    droppedDetail,
    rejected: rejected.length,
    rejectedDetail: rejected.map(r => ({ headline: r.headline, score: r.score, reasons: r.reasons })),
    total: merged.length,
    grounded: !!grounding,
    factsLoaded: !!facts,
    generatedAt: now,
    _score: avgScore,
    _promptHash: promptHash,
  });
}
