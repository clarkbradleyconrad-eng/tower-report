/**
 * Tower Report — /api/briefing
 *
 * Daily briefing generator. Calls Grok with web search to surface
 * the 5 most important Texas Longhorns football news items from the
 * last 48 hours, then caches the result in Vercel Blob.
 *
 * GET ?cron=1  — triggers Grok, writes to Blob, returns fresh data
 * GET          — returns cached briefing from Blob (no Grok call)
 *
 * Env vars:
 *   XAI_API_KEY           — xAI API key
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob token
 */

export const config = { runtime: 'edge' };

const BLOB_PATHNAME = 'tower-briefing.json';
// Prefix without extension — matches tower-briefing*.json including random-suffix variants
// (Vercel Blob REST API ignores addRandomSuffix=false; prefix must match the hash-inserted form)
const BLOB_PREFIX = 'tower-briefing';
const BLOB_API = 'https://blob.vercel-storage.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/* ---- Blob helpers ---- */

async function blobListAll(token) {
  const url = `${BLOB_API}?prefix=${encodeURIComponent(BLOB_PREFIX)}&token=${encodeURIComponent(token)}&limit=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`[tower/briefing] blobList failed: ${res.status} ${res.statusText}`);
    return [];
  }
  const data = await res.json();
  return data.blobs ?? [];
}

async function blobGet() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const blobs = await blobListAll(token);
    if (blobs.length === 0) return null;
    // Most recently uploaded blob wins (handles any accumulated orphans)
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].downloadUrl || blobs[0].url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function blobSet(data) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN not configured');

  // Delete ALL existing blobs matching prefix (clears orphans from prior failed deletes)
  const existing = await blobListAll(token);
  if (existing.length > 0) {
    await fetch(BLOB_API, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ urls: existing.map(b => b.url) }),
    });
  }

  // Upload new blob
  const putUrl = `${BLOB_API}/${BLOB_PATHNAME}?addRandomSuffix=false`;
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Blob write failed: ${err}`);
  }
}

/* ---- Grok call — identical pattern to generate-story.js ---- */

const SYSTEM = `You are the Tower Report briefing engine for Texas Longhorns football. Search the web for real verified news from the last 48 hours about Texas Longhorns football. Return exactly 5 briefing items covering DIFFERENT categories. You must include at minimum:
- 1 ROSTER or PROGRAM item (team news, depth chart, coaching, season outlook)
- 1 RECRUITING item (commits, targets, visits)
- 1 PORTAL or NIL item (transfers, NIL deals)
- 1 INTEL item (injury updates, betting lines, national rankings, CFP outlook)
- 1 item of your choice based on what is most newsworthy today
Never return more than 2 items from the same category. Prioritize variety and what a serious Texas football fan would actually want to know today.

Each item must have:
- category: one of RECRUITING, ROSTER, PORTAL, PROGRAM, INTEL, INJURY, NIL
- importance: HIGH, NORMAL, or URGENT
- headline: max 12 words, written like a confident beat reporter, include specific names and numbers
- context: one sentence, the single most important supporting detail, specific not vague
- source: actual outlet name (ON3, 247SPORTS, INSIDE TEXAS, RIVALS, BLEACHER REPORT, etc)
- url: the direct URL to the specific article or page you sourced this from (must be a real link you found via web search)
Only include real verified news. Never invent facts. Return valid JSON array only, no other text.`;

async function fetchFromGrok() {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const xaiRes = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-4',
      instructions: SYSTEM,
      input: [
        {
          role: 'user',
          content: `Today is ${today}. Search the web for the 5 most important Texas Longhorns football news items from the last 48 hours. Return only a valid JSON array of 5 items, no other text.`,
        },
      ],
      tools: [{ type: 'web_search' }],
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(55000),
  });

  if (!xaiRes.ok) {
    const errText = await xaiRes.text().catch(() => '');
    throw new Error(`xAI error ${xaiRes.status}: ${errText.slice(0, 200)}`);
  }

  const data = await xaiRes.json();
  const messageItem = data.output?.find(o => o.type === 'message');
  const content = messageItem?.content?.find(c => c.type === 'output_text')?.text;
  if (!content) throw new Error('Empty response from Grok');

  // Strip accidental markdown fences Grok sometimes adds
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const items = JSON.parse(cleaned);

  if (!Array.isArray(items) || items.length === 0) throw new Error('Invalid briefing payload');

  return items;
}

/* ---- Handler ---- */

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const isCron = new URL(req.url).searchParams.has('cron');

  // Regular GET: return cached Blob data only, never call Grok
  if (!isCron) {
    const cached = await blobGet();
    if (cached) return json(cached);
    // Nothing cached yet — return empty shell so frontend shows skeleton
    return json({ briefing: [], lastUpdated: null });
  }

  // Cron GET: call Grok, write to Blob, return fresh data
  if (!process.env.XAI_API_KEY) {
    return json({ error: 'XAI_API_KEY not configured' }, 503);
  }

  try {
    const items = await fetchFromGrok();
    const payload = {
      briefing: items,
      lastUpdated: new Date().toISOString(),
    };
    await blobSet(payload);
    return json(payload);
  } catch (err) {
    console.error('[tower/briefing] Grok failed:', err.message);
    // Fall back to last cached version so a cron failure never breaks the site
    const cached = await blobGet();
    if (cached) {
      console.log('[tower/briefing] returning stale cache after Grok failure');
      return json({ ...cached, stale: true });
    }
    return json({ error: err.message }, 502);
  }
}
