/**
 * Tower Report — /api/verify-recruiting
 *
 * Daily live recruiting check. Grok web-searches the current Texas 2027
 * class rank (On3 + 247Sports), commit count, and any new commits or
 * decommits, and stores the result — with named sources — in the
 * tower-recruiting-live.json blob. recruiting.html renders it as a
 * clearly-labeled "Live · via Grok" block NEXT TO the hand-verified
 * data/recruiting.json; it never overwrites verified data.
 *
 *   GET  /api/verify-recruiting            → cached live snapshot (public, fast)
 *   GET  /api/verify-recruiting?refresh=1  → run Grok, store, return fresh
 *                                            (requires CRON_SECRET when set)
 *
 * Env vars:
 *   XAI_API_KEY           — xAI API key
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token
 *   CRON_SECRET           — (optional) required for ?refresh=1 when set
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadPromptWithFacts } from '../bots/lib/prompts.js';
import { scoreRecruitingLive } from '../bots/lib/score.js';

const BLOB_API = 'https://blob.vercel-storage.com';
const BLOB_PATHNAME = 'tower-recruiting-live.json';
const BLOB_PREFIX = 'tower-recruiting-live'; // REST API appends a hash to the path

/* System prompt lives in bots/prompts/verify-recruiting.md (versioned; its
   hash is logged with every output so quality changes trace to prompt edits). */

/* ---- Blob helpers ---- */

async function blobList(token) {
  const res = await fetch(`${BLOB_API}?prefix=${encodeURIComponent(BLOB_PREFIX)}&limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return (await res.json()).blobs || [];
}

async function blobGet() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const blobs = await blobList(token);
    if (!blobs.length) return null;
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].downloadUrl || blobs[0].url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function blobSet(data) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN not configured');
  const existing = await blobList(token);
  if (existing.length) {
    await fetch(BLOB_API, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: existing.map(b => b.url) }),
    });
  }
  const res = await fetch(`${BLOB_API}/${BLOB_PATHNAME}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Blob write failed: ${await res.text().catch(() => res.status)}`);
}

/* ---- Sanitize: nulls beat nonsense ---- */

function intInRange(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function sanitize(raw) {
  const moves = (Array.isArray(raw.recentMoves) ? raw.recentMoves : [])
    .filter(m => m && typeof m.player === 'string' && m.player.trim().split(/\s+/).length >= 2
      && !/\b(multiple|various|several|unnamed|unknown|tbd)\b/i.test(m.player)
      && ['commit', 'decommit'].includes(String(m.type || '').toLowerCase()))
    .slice(0, 10)
    .map(m => ({
      date: String(m.date || '').slice(0, 40),
      type: String(m.type).toLowerCase(),
      player: m.player.trim(),
      pos: String(m.pos || '').slice(0, 8),
      note: String(m.note || '').slice(0, 300),
    }));
  return {
    on3TeamRank: intInRange(raw.on3TeamRank, 1, 150),
    sports247TeamRank: intInRange(raw.sports247TeamRank, 1, 150),
    commitCount: intInRange(raw.commitCount, 0, 50),
    recentMoves: moves,
    sources: (Array.isArray(raw.sources) ? raw.sources : [])
      .map(s => String(s).trim()).filter(Boolean).slice(0, 10),
  };
}

/* ---- Handler ---- */

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = new URL(req.url, 'http://localhost');
  const refresh = url.searchParams.get('refresh') === '1' || req.method === 'POST';

  if (!refresh) {
    const cached = await blobGet();
    res.setHeader('Cache-Control', 's-maxage=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(cached || { ok: false, note: 'No live recruiting check recorded yet', live: null });
  }

  // Refresh path — paid Grok call, gate it behind CRON_SECRET when configured
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers['authorization'] || '';
    const tokenParam = url.searchParams.get('token') || '';
    if (authHeader !== `Bearer ${secret}` && tokenParam !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'XAI_API_KEY not configured' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'BLOB_READ_WRITE_TOKEN not configured' });

  // ?dryRun=1 (orchestrator dry runs): full check, nothing stored
  const dryRun = url.searchParams.get('dryRun') === '1';

  let SYSTEM, promptHash;
  try {
    ({ text: SYSTEM, hash: promptHash } = await loadPromptWithFacts('verify-recruiting'));
  } catch (err) {
    return res.status(503).json({ error: 'Prompt load failed', message: err.message });
  }

  // Hand-verified baseline for the prompt (never overwritten by this endpoint)
  let verified = null;
  try {
    verified = JSON.parse(await readFile(path.join(process.cwd(), 'data/recruiting.json'), 'utf8'));
  } catch { /* grounding is optional */ }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  let userMessage = `Today is ${today}. Verify the current Texas Longhorns 2027 recruiting class numbers via web search and return the JSON object.`;
  if (verified?.meta) {
    userMessage += `\n\nFor reference, Tower Report's last hand-verified snapshot (${verified.lastUpdated}) had: On3 rank #${verified.meta.on3Rank}, 247Sports rank #${verified.meta.sports247Rank}, ${verified.meta.publicCommits} public commits. Report what the sites say TODAY — do not just repeat these numbers.`;
  }

  try {
    const xaiRes = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-4',
        instructions: SYSTEM,
        input: [{ role: 'user', content: userMessage }],
        tools: [{ type: 'web_search' }],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(75000),
    });

    if (!xaiRes.ok) {
      const errBody = await xaiRes.text().catch(() => '');
      console.error('[tower/verify-recruiting] xAI error', xaiRes.status, errBody.slice(0, 300));
      return res.status(502).json({ error: 'xAI error', code: xaiRes.status });
    }

    const data = await xaiRes.json();
    const messageItem = data.output?.find(o => o.type === 'message');
    const content = messageItem?.content?.find(c => c.type === 'output_text')?.text;
    if (!content) throw new Error('Empty response from Grok');

    const live = sanitize(JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')));

    if (!live.sources.length) {
      // Nothing verifiable found — keep the previous snapshot instead of
      // storing an unsourced blank
      console.warn('[tower/verify-recruiting] no sources returned; keeping previous snapshot');
      const prev = await blobGet();
      return res.status(200).json({ ok: false, note: 'Grok returned no verifiable sources; previous snapshot kept', live: prev?.live || null, updatedAt: prev?.updatedAt || null });
    }

    const { score } = scoreRecruitingLive(live);
    const payload = { ok: true, updatedAt: new Date().toISOString(), via: 'Grok web search', live, _score: score, _promptHash: promptHash };
    if (!dryRun) await blobSet(payload);
    console.log(`[tower/verify-recruiting] on3=${live.on3TeamRank} 247=${live.sports247TeamRank} commits=${live.commitCount} moves=${live.recentMoves.length} sources=${live.sources.join(',')} score=${score} dryRun=${dryRun}`);
    return res.status(200).json(dryRun ? { ...payload, dryRun: true } : payload);
  } catch (err) {
    console.error('[tower/verify-recruiting]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
