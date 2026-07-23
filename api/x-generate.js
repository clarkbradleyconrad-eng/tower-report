/**
 * Tower Report — /api/x-generate
 *
 * Reads the daily briefing + top story, runs the x-writer prompt through
 * Grok with web search, and adds the generated posts to the x-queue blob.
 *
 * GET /api/x-generate             — standard generate + queue
 * GET /api/x-generate?dryRun=1    — generate but do NOT write to queue
 * GET /api/x-generate?cron=1      — allow via CRON_SECRET
 *
 * Auth: OPS_KEY (x-ops-key header or ?key=) OR CRON_SECRET (Bearer / ?token=)
 * Env: XAI_API_KEY, BLOB_READ_WRITE_TOKEN, OPS_KEY, CRON_SECRET (optional)
 */

import { blobGetJson } from '../bots/lib/blob.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PROMPT_PATH = join(process.cwd(), 'bots', 'prompts', 'x-writer.md');
const BASE_URL    = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';

function authOk(req) {
  const url    = new URL(req.url, 'http://localhost');
  const secret = process.env.CRON_SECRET;
  const opsKey = process.env.OPS_KEY;

  if (secret) {
    const auth = req.headers['authorization'] || '';
    const tok  = url.searchParams.get('token') || '';
    if (auth === `Bearer ${secret}` || tok === secret) return true;
  }
  if (opsKey) {
    const h = req.headers['x-ops-key'] || '';
    const p = url.searchParams.get('key') || '';
    if (h === opsKey || p === opsKey) return true;
  }
  return !secret && !opsKey;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchSettings() {
  try {
    const r = await fetch(`${BASE_URL}/api/x-settings`);
    const j = await r.json();
    return j.settings || {};
  } catch { return {}; }
}

async function fetchRecentPosts() {
  try {
    const r = await fetch(`${BASE_URL}/api/x-queue?status=posted`);
    const j = await r.json();
    return (j.items || []).slice(0, 10).map(i => i.text);
  } catch { return []; }
}

async function runGrok(prompt) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');

  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4',
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_preview' }],
      tool_choice: 'auto',
      temperature: 0.8,
      max_tokens: 4096,
    }),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => r.status);
    throw new Error(`Grok API error ${r.status}: ${txt}`);
  }

  const data  = await r.json();
  const text  = data.choices?.[0]?.message?.content || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Grok response');
  return JSON.parse(match[0]);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });

  const url    = new URL(req.url, 'http://localhost');
  const dryRun = url.searchParams.get('dryRun') === '1';

  // Load inputs in parallel
  const [briefingBlob, storiesBlob, settings, recentPosts, promptTemplate] = await Promise.all([
    blobGetJson('tower-briefing'),
    blobGetJson('tower-ai-stories'),
    fetchSettings(),
    fetchRecentPosts(),
    readFile(PROMPT_PATH, 'utf8').catch(() => null),
  ]);

  if (!promptTemplate) {
    return res.status(503).json({ error: 'x-writer.md prompt file not found' });
  }

  const briefing  = (briefingBlob?.briefing || []).slice(0, 5);
  const stories   = Array.isArray(storiesBlob) ? storiesBlob : (storiesBlob?.stories || []);
  const topStory  = stories.filter(s => !s.rejected).sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

  const facts = `
Today's date: ${today()}

BRIEFING (top ${briefing.length} Texas football news items):
${briefing.map((b, i) => `${i + 1}. ${b.headline || b.text}${b.source ? ` (${b.source})` : ''}${b.context ? '\n   ' + b.context : ''}`).join('\n')}

TOP STORY:
${topStory ? `Headline: ${topStory.headline}\nHook: ${topStory.hook || ''}\nWhy it matters: ${topStory.whyItMatters || ''}` : 'No story available'}

RECENT POSTS (do not repeat these topics):
${recentPosts.map((t, i) => `${i + 1}. ${t.slice(0, 120)}`).join('\n') || 'None'}

SETTINGS:
- Mode: ${settings.mode || 'manual'}
- Categories enabled: ${(settings.categories || []).join(', ')}
- Blacklisted topics: ${(settings.blacklistTopics || []).join(', ') || 'none'}
- Blacklisted sources: ${(settings.blacklistSources || []).join(', ') || 'none'}
- Max posts per day: ${settings.maxPostsPerDay || 5}
- Link ratio target: ${settings.linkRatioPct || 30}%
`.trim();

  const prompt = promptTemplate.replace('{{FACTS}}', facts);

  let result;
  try {
    result = await runGrok(prompt);
  } catch (err) {
    return res.status(502).json({ error: 'Generation failed', detail: err.message });
  }

  const posts = Array.isArray(result?.posts) ? result.posts : [];
  if (!posts.length) {
    return res.status(200).json({ ok: true, generated: 0, message: 'No posts generated', dryRun });
  }

  // Sanitize and cap text
  const sanitized = posts.map(p => ({
    ...p,
    text: String(p.text || '').slice(0, 280),
    generatedBy: 'x-generate',
  }));

  if (dryRun) {
    return res.status(200).json({ ok: true, generated: sanitized.length, posts: sanitized, dryRun: true });
  }

  // Write to queue via /api/x-queue
  try {
    const r = await fetch(`${BASE_URL}/api/x-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ops-key': process.env.OPS_KEY || '' },
      body: JSON.stringify({ posts: sanitized }),
    });
    const j = await r.json();
    return res.status(200).json({ ok: true, generated: sanitized.length, queued: j.added || 0, dryRun: false });
  } catch (err) {
    return res.status(500).json({ error: 'Queue write failed', detail: err.message });
  }
}
