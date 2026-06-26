/**
 * Tower Report — /api/stories-refresh
 *
 * Cron job: generates 15 fresh AI stories via Grok 4 + web search,
 * merges them into the persistent archive in Vercel Blob, deduplicates,
 * and caps the archive at 60 stories. The /api/stories endpoint reads
 * from this archive — instant, no AI latency at page load time.
 *
 * Triggered by: Vercel cron (GET) or manual call (GET/POST).
 * Node.js runtime for the 60-second timeout Grok needs.
 *
 * Env vars:
 *   XAI_API_KEY           — xAI API key
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token
 *   CRON_SECRET           — (optional) auth secret; if set, required on all calls
 */

const BLOB_PATHNAME = 'tower-ai-stories.json';
const BLOB_API = 'https://blob.vercel-storage.com';
const MAX_STORED = 60;

const SYSTEM = `You are Tower AI — the intelligence engine for Tower Report, the premier Texas Longhorns football analysis platform.

Search the web RIGHT NOW and find the most current, important Texas Longhorns football news from the past 48 hours. Analyze, rank, and format each story for Longhorn fans who demand more than headlines.

Return ONLY a valid JSON object — no markdown fences, no text outside the JSON:

{
  "lastUpdated": "<ISO 8601 timestamp>",
  "totalSignals": <integer between 800 and 1400>,
  "stories": [
    {
      "rank": 1,
      "headline": "<specific, compelling, fact-based headline — not a question, not vague>",
      "category": "<exactly one of: Program Outlook | QB & Offense | Defense & Stars | Roster & Portal | Recruiting | Coaching | Game Recap | Film Room>",
      "kicker": "<8-14 chars, ALL CAPS: the story type label shown above the headline, e.g. 'QB INTEL', 'PORTAL MOVE', 'INJURY REPORT', 'TRANSFER WIRE', 'RECRUITING', 'FILM ROOM', 'COACHING', 'CFP OUTLOOK'>",
      "impact": <integer 70-99>,
      "trending": <true or false>,
      "date": "<Month D, YYYY>",
      "hook": "<2-3 sentences: the key fact + why Longhorn fans should care RIGHT NOW>",
      "whyItMatters": "<1 sentence: the single most important football implication — specific, football-language, no hedging>",
      "affectedPositions": ["<2-5 letter position codes from: QB, RB, WR, TE, OL, DL, LB, CB, S, EDGE, K, P, ST>"],
      "players": ["<First Last>"],
      "tags": ["<tag1>", "<tag2>", "<tag3>"],
      "overview": "<Full analysis. Use EXACTLY this structure and no other HTML tags: 'What happened: [detailed factual paragraph]<br><br><strong>Why it matters:</strong> [football-specific impact paragraph]<br><br><strong>Football impact:</strong> [how this changes the depth chart, scheme, or game plan]<br><br><strong>What to watch next:</strong> [specific upcoming events, decisions, or dates to monitor]'>",
      "takeaways": ["<key insight 1 — specific, factual>", "<key insight 2>", "<key insight 3>"],
      "watchNext": "<2-3 sentences: what specific developments to monitor in the next 7-14 days>",
      "relatedImpact": "<1 sentence connecting this story to Texas's 2026 CFP championship path>",
      "sources": ["<Publication Name 1>", "<Publication Name 2>"]
    }
  ]
}

Tower AI Ranking Methodology:
- 40%: Program & Roster Impact — direct effect on 2026 wins, CFP odds, depth chart, championship trajectory
- 25%: Fan & Social Velocity — real-time volume and sentiment on X, Longhorn forums, 247Sports
- 20%: Recruiting & Portal Momentum — commitments, flips, decommits, visits, portal entries/exits
- 15%: Expert & Media Consensus — 247Sports Crystal Balls, ESPN/On3 analysis, Vegas lines

Priority topics: Arch Manning health and performance, transfer portal activity, Steve Sarkisian decisions, recruiting (commits, visits, decommits), player injuries or returns, upcoming schedule (especially Ohio State Week 2), CFP outlook, NIL developments, Will Muschamp defense, depth chart battles.

Rules:
- Rank #1 = highest impact. Do not rank by date.
- Return between 12 and 15 stories.
- Every story must be grounded in real news you found via web search.
- affectedPositions must use standard abbreviations from the list provided.
- No text, no explanation, no markdown — just the raw JSON object.`;

function slugify(headline) {
  return 'ai-' + String(headline)
    .toLowerCase()
    .replace(/[''""]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

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

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'XAI_API_KEY not configured' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: 'BLOB_READ_WRITE_TOKEN not configured' });
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  // Generate stories via Grok
  let freshStories = [];
  try {
    const xaiRes = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-4',
        instructions: SYSTEM,
        input: [{
          role: 'user',
          content: `Today is ${today}. Search the web for the latest Texas Longhorns football news. Return 12-15 stories ranked by the Tower AI methodology. Return ONLY the JSON object.`,
        }],
        tools: [{ type: 'web_search' }],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(55000),
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

  // Load existing archive
  const existing = await blobGet();
  const existingSlugs = new Set(existing.map(s => s.id || slugify(s.headline || '')));

  // Normalize new stories: assign slug IDs, deduplicate
  const now = new Date().toISOString();
  const toAdd = [];
  for (const story of freshStories) {
    const id = slugify(story.headline);
    if (existingSlugs.has(id)) continue;
    existingSlugs.add(id);
    toAdd.push({ ...story, id, _generated: now });
  }

  // Merge new first, cap archive
  const merged = [...toAdd, ...existing].slice(0, MAX_STORED);

  try {
    await blobSet(merged);
  } catch (err) {
    console.error('[tower/stories-refresh] blob error:', err.message);
    return res.status(500).json({ error: 'Blob save failed', message: err.message });
  }

  console.log(`[tower/stories-refresh] added ${toAdd.length}, total ${merged.length}`);
  return res.status(200).json({ ok: true, added: toAdd.length, total: merged.length, generatedAt: now });
}
