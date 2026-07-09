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

// Node runtime (was edge): edge functions must send the first byte within
// ~25s, and a non-streaming Grok web-search call regularly takes longer —
// runs 504'd whenever Grok was slow. vercel.json sets maxDuration: 90.

import { loadPromptWithFacts } from '../bots/lib/prompts.js';
import { scoreBriefing, REJECT_THRESHOLD } from '../bots/lib/score.js';
import { pushRejected } from '../bots/lib/blob.js';

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

function json(res, data, status = 200) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(data);
}

/* ---- Blob helpers ---- */

async function blobListAll(token) {
  const url = `${BLOB_API}?prefix=${encodeURIComponent(BLOB_PREFIX)}&limit=100`;
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

/* ---- Grok call — identical pattern to generate-story.js ----
   System prompt lives in bots/prompts/briefing.md (versioned; hash logged
   with every output so quality changes trace to prompt edits). */

async function fetchFromGrok() {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');

  const { text: SYSTEM, hash: promptHash } = await loadPromptWithFacts('briefing');

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
    signal: AbortSignal.timeout(80000),
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

  // Stable per-item ids so the homepage can deep-link each brief to /story?id=…
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  items.forEach((item, i) => { item.id = `brief-${dateKey}-${i + 1}`; });

  return { items, promptHash };
}

/* ---- Handler ---- */

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return json(res, { error: 'Method not allowed' }, 405);
  }

  const url = new URL(req.url, 'http://localhost');
  const isCron = url.searchParams.has('cron');

  // Regular GET: return cached Blob data only, never call Grok
  if (!isCron) {
    const cached = await blobGet();
    if (cached) return json(res, cached);
    // Nothing cached yet — return empty shell so frontend shows skeleton
    return json(res, { briefing: [], lastUpdated: null });
  }

  // Cron GET: call Grok, write to Blob, return fresh data.
  // Each run is a paid Grok call and overwrites the cache, so once
  // CRON_SECRET is configured, require it (Bearer header or ?token=).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const bearer = req.headers['authorization'] || '';
    const token = url.searchParams.get('token') || '';
    if (bearer !== `Bearer ${secret}` && token !== secret) {
      return json(res, { error: 'Unauthorized' }, 401);
    }
  }

  if (!process.env.XAI_API_KEY) {
    return json(res, { error: 'XAI_API_KEY not configured' }, 503);
  }

  // ?dryRun=1 (orchestrator dry runs): generate + grade but never publish
  const dryRun = url.searchParams.get('dryRun') === '1';

  try {
    const { items, promptHash } = await fetchFromGrok();

    // Quality gate: graded 0-100 (bots/lib/score.js); below threshold the
    // fresh briefing is rejected to the review queue and the cache stays.
    const { score, reasons } = scoreBriefing(items);
    if (score < REJECT_THRESHOLD) {
      console.warn(`[tower/briefing] REJECTED score=${score}: ${reasons.join('; ')}`);
      if (!dryRun) {
        await pushRejected('briefing', { promptHash, score, reasons, output: items });
      }
      const cached = await blobGet();
      return json(res, { ...(cached || { briefing: [], lastUpdated: null }), rejected: true, _score: score, _promptHash: promptHash });
    }

    const payload = {
      briefing: items,
      lastUpdated: new Date().toISOString(),
      _score: score,
      _promptHash: promptHash,
    };
    if (!dryRun) await blobSet(payload);
    return json(res, dryRun ? { ...payload, dryRun: true } : payload);
  } catch (err) {
    console.error('[tower/briefing] Grok failed:', err.message);
    // Fall back to last cached version so a cron failure never breaks the site
    const cached = await blobGet();
    if (cached) {
      console.log('[tower/briefing] returning stale cache after Grok failure');
      return json(res, { ...cached, stale: true });
    }
    return json(res, { error: err.message }, 502);
  }
}
