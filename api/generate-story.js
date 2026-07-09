/**
 * Tower Report — /api/generate-story
 *
 * Newsroom AI story generator. Takes a topic/event and produces a full
 * Tower Report article + four Twitter/X drafts using Grok with live search.
 *
 * POST body: { eventType, topic, sourceContent?, sourceUrl? }
 * Returns:   { story: {...}, socialPosts: { breaking, analysis, engagement, readMore } }
 *
 * Env vars:
 *   XAI_API_KEY — xAI API key
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validateStory, normalizeImpactBreakdown,
} from './_lib/story-standards.js';
import { loadPromptWithFacts } from '../bots/lib/prompts.js';
import { scoreStory, REJECT_THRESHOLD } from '../bots/lib/score.js';
import { pushRejected } from '../bots/lib/blob.js';

// Node runtime (was edge): edge functions must send the first byte within
// ~25s and Grok web-search calls regularly take longer — runs 504'd whenever
// Grok was slow. vercel.json sets maxDuration: 90 + bundles data/.

async function loadFacts() {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), 'data/facts.json'), 'utf8'));
  } catch {
    try {
      const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'tower-report.vercel.app';
      const res = await fetch(`https://${host}/data/facts.json`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Desk-Key, Authorization',
};

function json(res, data, status = 200) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(data);
}

// Each call is a paid Grok-4 + web-search request. Require the desk key
// (X-Desk-Key) or cron secret (Bearer) once either env var is configured;
// with neither set, behavior is unchanged so nothing breaks pre-provisioning.
function authorized(req) {
  const desk = process.env.DESK_PASSWORD;
  const cron = process.env.CRON_SECRET;
  if (!desk && !cron) return true;
  const key = req.headers['x-desk-key'] || '';
  const bearer = req.headers['authorization'] || '';
  return (desk && key === desk) || (cron && bearer === `Bearer ${cron}`);
}

/* System prompt lives in bots/prompts/story-generator.md (versioned; its
   hash is logged with every output so quality changes trace to prompt edits). */

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return json(res, { error: 'Method not allowed' }, 405);
  }

  if (!authorized(req)) {
    return json(res, { error: 'Unauthorized' }, 401);
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return json(res, { error: 'XAI_API_KEY not configured' }, 503);
  }

  // Vercel's Node runtime parses JSON bodies into req.body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return json(res, { error: 'Invalid JSON body' }, 400);
  }

  const { eventType, topic, sourceContent, sourceUrl } = body;

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const facts = await loadFacts();

  // Versioned system prompt with the facts block injected ({{FACTS}} token)
  let SYSTEM, promptHash;
  try {
    ({ text: SYSTEM, hash: promptHash } = await loadPromptWithFacts('story-generator', facts));
  } catch (err) {
    return json(res, { error: 'Prompt load failed', message: err.message }, 503);
  }

  // ?dryRun=1 (orchestrator dry runs): nothing lands in the review queue
  const dryRun = new URL(req.url, 'http://localhost').searchParams.get('dryRun') === '1';

  let userPrompt = `Today is ${today}.\n\n`;
  userPrompt += `Event type: ${eventType || 'Program News'}\n\n`;
  if (topic) userPrompt += `Story topic: ${topic}\n\n`;
  if (sourceContent) userPrompt += `Source content (use this as the factual foundation):\n${sourceContent}\n\n`;
  if (sourceUrl) userPrompt += `Source URL: ${sourceUrl}\n\n`;
  userPrompt += 'Search the web for the latest information on this topic. Write the full Tower Report article and return only the JSON object.';

  try {
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
          { role: 'user', content: userPrompt },
        ],
        tools: [{ type: 'web_search' }],
        temperature: 0.25,
      }),
      signal: AbortSignal.timeout(80000),
    });

    if (!xaiRes.ok) {
      const errText = await xaiRes.text().catch(() => '');
      console.error('[tower/generate-story] xAI error', xaiRes.status, errText.slice(0, 300));
      return json(res, { error: 'AI generation failed', code: 'XAI_ERROR' }, 502);
    }

    const data = await xaiRes.json();
    const messageItem = data.output?.find(o => o.type === 'message');
    const content = messageItem?.content?.find(c => c.type === 'output_text')?.text;
    if (!content) throw new Error('Empty response from Grok');

    const parsed = JSON.parse(content);
    if (!parsed.story?.title) throw new Error('Invalid story payload');

    // Accuracy gate — same standards as stories-refresh. A story that fails
    // is never returned or saved; the caller gets the reasons for the log.
    const check = validateStory(
      { ...parsed.story, takeaways: parsed.story.takeaways || parsed.story.keySignals },
      facts
    );
    if (!check.ok) {
      console.warn('[tower/generate-story] REJECTED:', parsed.story.title, '—', check.reasons.join('; '));
      if (!dryRun) {
        await pushRejected('story-generator', { promptHash, score: null, reasons: check.reasons, output: parsed.story })
          .catch(e => console.warn('[tower/generate-story] rejected-queue write failed:', e.message));
      }
      return json(res, { error: 'Story rejected by accuracy gate', code: 'STORY_REJECTED', rejected: true, headline: parsed.story.title, reasons: check.reasons, _promptHash: promptHash }, 422);
    }
    normalizeImpactBreakdown(parsed.story);

    // Quality score 0-100 — below threshold the story goes to the review
    // queue on ops.html instead of the newsroom
    const graded = scoreStory(
      { ...parsed.story, takeaways: parsed.story.takeaways || parsed.story.keySignals },
      facts
    );
    if (graded.score < REJECT_THRESHOLD) {
      console.warn(`[tower/generate-story] LOW SCORE ${graded.score}:`, parsed.story.title, '—', graded.reasons.join('; '));
      if (!dryRun) {
        await pushRejected('story-generator', { promptHash, score: graded.score, reasons: graded.reasons, output: parsed.story })
          .catch(e => console.warn('[tower/generate-story] rejected-queue write failed:', e.message));
      }
      return json(res, { error: 'Story below quality threshold', code: 'STORY_REJECTED', rejected: true, headline: parsed.story.title, reasons: graded.reasons, _score: graded.score, _promptHash: promptHash }, 422);
    }

    const id = `story-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const story = {
      ...parsed.story,
      id,
      status: 'draft',
      createdAt: new Date().toISOString(),
      publishedAt: null,
      url: null,
      source: 'Tower Report',
      depthLevel: 'deep',
      isStoryOfTheDay: false,
      imageUrl: null,
      readTime: Math.max(2, Math.round((
        (parsed.story.whatHappened || '').length +
        (parsed.story.whyItMatters || '').length +
        (parsed.story.impactOnTexas || '').length
      ) / 1200)),
    };

    return json(res, { story, socialPosts: parsed.socialPosts || {}, _score: graded.score, _promptHash: promptHash });

  } catch (err) {
    console.error('[tower/generate-story]', err.message);
    return json(res, { error: err.message }, 500);
  }
}
