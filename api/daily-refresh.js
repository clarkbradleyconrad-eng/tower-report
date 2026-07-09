/**
 * Tower Report — /api/daily-refresh
 *
 * Cron orchestrator. Vercel's Hobby plan allows only 2 cron jobs (each once
 * per day), so instead of one cron per endpoint this single endpoint runs
 * every pipeline step in sequence:
 *
 *   1. /api/briefing?cron=1      — daily briefing via Grok
 *   2. /api/generate-story       — daily AI draft for the newsroom (saved as
 *                                  a draft in stories-db; never auto-published)
 *   3. /api/stories-refresh      — 3 fresh grounded AI stories into the archive
 *   4. /api/verify-recruiting    — live 2027 class rank/commit check via Grok
 *   5. /api/odds?cron=1          — odds cache warm
 *
 * Each step has its own try/catch and timing log, so one failure never kills
 * the rest. Every run writes a heartbeat (timestamp + per-step results) to
 * the tower-refresh-log.json blob, which /api/health reads.
 *
 * Cron: twice daily (see vercel.json). Manual: GET /api/daily-refresh
 * (?token={CRON_SECRET} if CRON_SECRET is set).
 *
 * Env vars:
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token (heartbeat log)
 *   CRON_SECRET           — (optional) auth secret; if set, required on all calls
 */

const BLOB_API = 'https://blob.vercel-storage.com';
const LOG_PATHNAME = 'tower-refresh-log.json';
const LOG_PREFIX = 'tower-refresh-log'; // prefix without .json — REST API appends a hash
const MAX_LOGGED_RUNS = 30;
const STEP_TIMEOUT_MS = 58000;

function baseUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL
    || 'tower-report.vercel.app';
  return `https://${host}`;
}

/* ---- Heartbeat log blob helpers ---- */

async function logBlobList(token) {
  const url = `${BLOB_API}?prefix=${encodeURIComponent(LOG_PREFIX)}&limit=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.blobs || [];
}

async function logGet() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const blobs = await logBlobList(token);
    if (!blobs.length) return null;
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].downloadUrl || blobs[0].url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function logSet(log) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN not configured');
  const existing = await logBlobList(token);
  if (existing.length) {
    await fetch(BLOB_API, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: existing.map(b => b.url) }),
    });
  }
  const res = await fetch(`${BLOB_API}/${LOG_PATHNAME}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(log),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Heartbeat blob write failed: ${err}`);
  }
}

/* ---- Steps ---- */

async function runStep(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    console.log(`[tower/daily-refresh] step=${name} ok ms=${ms}`);
    return { name, ok: true, ms, detail: detail || null };
  } catch (err) {
    const ms = Date.now() - started;
    console.error(`[tower/daily-refresh] step=${name} FAILED ms=${ms}: ${err.message}`);
    return { name, ok: false, ms, error: String(err.message).slice(0, 300) };
  }
}

async function stepFetch(url, init = {}, timeoutMs = STEP_TIMEOUT_MS) {
  // Forward the cron secret so downstream endpoints that enforce it
  // (stories-db, generate-story, briefing) accept the call
  const secret = process.env.CRON_SECRET;
  const headers = {
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch { return { raw: body.slice(0, 200) }; }
}

async function stepBriefing(base) {
  const data = await stepFetch(`${base}/api/briefing?cron=1`);
  return { items: Array.isArray(data.briefing) ? data.briefing.length : 0, stale: !!data.stale };
}

async function stepVerifyRecruiting(base) {
  const secret = process.env.CRON_SECRET;
  const url = `${base}/api/verify-recruiting?refresh=1${secret ? `&token=${encodeURIComponent(secret)}` : ''}`;
  const data = await stepFetch(url, {}, 88000);
  return { on3Rank: data.live?.on3TeamRank ?? null, sports247Rank: data.live?.sports247TeamRank ?? null, commits: data.live?.commitCount ?? null, sources: (data.live?.sources || []).length };
}

// Generates one AI draft story for the newsroom and saves it to stories-db
// as status:'draft' (invisible on the public page until an editor publishes).
// Replaces the previous auto-generated draft so drafts don't pile up.
async function stepGenerateStory(base) {
  const gen = await stepFetch(`${base}/api/generate-story`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventType: 'Program News',
      topic: 'The single most important verified Texas Longhorns football development of the last 24 hours',
    }),
  });
  if (!gen.story?.id) throw new Error('generate-story returned no story');

  const story = { ...gen.story, _auto: true };

  // Drop older auto drafts (keep the newsroom clean), then save the new one
  try {
    const db = await stepFetch(`${base}/api/stories-db`);
    const staleDrafts = (db.stories || []).filter(s => s._auto && s.status === 'draft' && s.id !== story.id);
    for (const s of staleDrafts.slice(0, 5)) {
      await stepFetch(`${base}/api/stories-db?id=${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    }
  } catch (err) {
    console.warn('[tower/daily-refresh] auto-draft cleanup skipped:', err.message);
  }

  await stepFetch(`${base}/api/stories-db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ story }),
  });
  return { draftId: story.id, title: story.title };
}

async function stepStoriesRefresh(base) {
  const secret = process.env.CRON_SECRET;
  const url = `${base}/api/stories-refresh${secret ? `?token=${encodeURIComponent(secret)}` : ''}`;
  // stories-refresh has maxDuration 90 (Grok + blob merge can pass 58s);
  // aborting at the default step timeout logged false failures for runs
  // that finished successfully server-side.
  const data = await stepFetch(url, {}, 88000);
  return {
    added: data.added,
    droppedDuplicates: data.droppedDuplicates,
    rejected: data.rejected,
    rejectedDetail: (data.rejectedDetail || []).map(r => ({ headline: r.headline, reasons: (r.reasons || []).join('; ').slice(0, 200) })),
    total: data.total,
  };
}

async function stepOdds(base) {
  const data = await stepFetch(`${base}/api/odds?cron=1`);
  return { source: data.meta?.source, liveGames: data.meta?.liveGames };
}

/* ---- Handler ---- */

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers['authorization'] || '';
    const tokenParam = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    if (authHeader !== `Bearer ${secret}` && tokenParam !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const base = baseUrl();
  const startedAt = new Date().toISOString();
  // Vercel cron invocations carry the x-vercel-cron header and a
  // vercel-cron user-agent; with CRON_SECRET set they also send the
  // Authorization header. Check all three so the heartbeat's trigger
  // label is accurate even before CRON_SECRET is configured.
  const isCron = !!req.headers['x-vercel-cron']
    || /vercel-cron/i.test(req.headers['user-agent'] || '')
    || !!req.headers['authorization']
    || 'cron' in Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);

  const steps = [];
  steps.push(await runStep('briefing', () => stepBriefing(base)));
  steps.push(await runStep('generate-story', () => stepGenerateStory(base)));
  steps.push(await runStep('stories-refresh', () => stepStoriesRefresh(base)));
  steps.push(await runStep('verify-recruiting', () => stepVerifyRecruiting(base)));
  steps.push(await runStep('odds', () => stepOdds(base)));

  const finishedAt = new Date().toISOString();
  const run = { startedAt, finishedAt, trigger: isCron ? 'cron' : 'manual', steps };

  // Heartbeat: persist this run + per-step last-success timestamps
  let heartbeatOk = true;
  try {
    const log = (await logGet()) || { lastRun: null, lastSuccess: {}, runs: [] };
    log.lastRun = finishedAt;
    delete log.lastSuccess['tiktok-drafts']; // step removed from the pipeline
    for (const s of steps) {
      if (s.ok) log.lastSuccess[s.name] = finishedAt;
    }
    log.runs = [run, ...(log.runs || [])].slice(0, MAX_LOGGED_RUNS);
    await logSet(log);
  } catch (err) {
    heartbeatOk = false;
    console.error('[tower/daily-refresh] heartbeat write failed:', err.message);
  }

  const allOk = steps.every(s => s.ok);
  console.log(`[tower/daily-refresh] done ok=${allOk} steps=${steps.map(s => `${s.name}:${s.ok ? 'ok' : 'FAIL'}(${s.ms}ms)`).join(' ')}`);
  return res.status(200).json({ ok: allOk, heartbeatOk, startedAt, finishedAt, steps });
}
