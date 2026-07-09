/**
 * Tower Report — /api/ops
 *
 * Backend for ops.html (the bot control room). Read side aggregates the
 * registry, run logs, quality stats, rejection queues, social drafts, and
 * NEEDS-VERIFICATION.md into one dashboard payload. Write side handles
 * enable/disable toggles and review-queue decisions. Bot runs themselves
 * are triggered against /api/orchestrator directly.
 *
 * Auth: OPS_KEY env var (or CRON_SECRET as fallback), passed as ?key= or
 * X-Ops-Key. If neither env var is set, the endpoint stays open and the
 * payload flags secured:false so the dashboard shows a warning.
 *
 *   GET  /api/ops?view=dashboard
 *   POST /api/ops   body: { action: 'toggle', botId, enabled }
 *                       | { action: 'rejected-approve', botId, ts }
 *                       | { action: 'rejected-dismiss', botId, ts }
 *                       | { action: 'nv-dismiss', id }
 *                       | { action: 'social-approve' } | { action: 'social-dismiss' }
 */

import { loadBots } from '../bots/lib/registry.js';
import { blobGetJson, blobPutJson, blobUpdateJson, KEYS } from '../bots/lib/blob.js';
import { readRepoText } from '../bots/lib/repo.js';

const STORIES_DB = { path: 'tower-stories.json', prefix: 'tower-stories' };
const MAX_STORED = 60;

function opsKey() {
  return process.env.OPS_KEY || process.env.CRON_SECRET || null;
}

function authorized(req, params) {
  const key = opsKey();
  if (!key) return true; // unsecured until OPS_KEY is provisioned — flagged in payload
  return params.get('key') === key || req.headers['x-ops-key'] === key;
}

function json(res, data, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ops-Key');
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(data);
}

/* NEEDS-VERIFICATION.md → review-queue items */
function parseNV(text, dismissed) {
  if (!text) return [];
  const items = [];
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const title = part.slice(0, nl).trim();
    const id = 'nv-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    items.push({
      id,
      title,
      excerpt: part.slice(nl + 1).trim().replace(/\s+/g, ' ').slice(0, 320),
      dismissed: (dismissed || []).includes(id),
    });
  }
  return items;
}

async function dashboard() {
  const [{ registry, overrides, bots }, runsLog, stats, rejected, social, nvText] = await Promise.all([
    loadBots(),
    blobGetJson(KEYS.runs.prefix),
    blobGetJson(KEYS.stats.prefix),
    blobGetJson(KEYS.rejected.prefix),
    blobGetJson(KEYS.social.prefix),
    readRepoText('NEEDS-VERIFICATION.md'),
  ]);

  const runs = (runsLog?.runs || []).slice(0, 15);
  const nv = parseNV(nvText, overrides.dismissedNV);
  const rejectedByBot = rejected && typeof rejected === 'object' ? rejected : {};

  // Per-bot rollups the dashboard renders directly
  const now = Date.now();
  const botViews = bots.map(b => {
    const entries = (stats?.[b.id] || []).filter(e => now - new Date(e.t).getTime() <= 30 * 24 * 3600 * 1000);
    const scores = entries.filter(e => e.score != null);
    const durations = entries.filter(e => e.ms != null);
    // pass/fail streak: consecutive same-outcome runs from most recent
    let streak = 0, streakOk = null;
    for (const e of entries) {
      if (streakOk === null) { streakOk = e.ok; streak = 1; }
      else if (e.ok === streakOk) streak++;
      else break;
    }
    const lastRunEntry = entries[0] || null;
    return {
      id: b.id, name: b.name, purpose: b.purpose, kind: b.kind,
      schedule: b.schedule, promptFile: b.promptFile, dependsOn: b.dependsOn,
      enabled: b.enabled, enabledSource: b.enabledSource, timeoutMs: b.timeoutMs,
      lastRun: lastRunEntry ? { t: lastRunEntry.t, ok: lastRunEntry.ok, score: lastRunEntry.score, ms: lastRunEntry.ms, promptHash: lastRunEntry.promptHash } : null,
      streak: streakOk === null ? null : { ok: streakOk, count: streak },
      avgScore: scores.length ? +(scores.reduce((a, e) => a + e.score, 0) / scores.length).toFixed(1) : null,
      avgMs: durations.length ? Math.round(durations.reduce((a, e) => a + e.ms, 0) / durations.length) : null,
      // oldest→newest for sparklines
      spark: entries.slice(0, 30).reverse().map(e => ({ t: e.t, score: e.score, ok: e.ok })),
      // rolling average per prompt version (traces quality to prompt edits)
      byPrompt: Object.entries(scores.reduce((acc, e) => {
        const h = e.promptHash || 'unversioned';
        (acc[h] = acc[h] || []).push(e.score);
        return acc;
      }, {})).map(([hash, list]) => ({ hash, runs: list.length, avg: +(list.reduce((a, s) => a + s, 0) / list.length).toFixed(1) })),
      rejectedCount: (rejectedByBot[b.id] || []).length,
    };
  });

  const reviewQueueSize = Object.values(rejectedByBot).reduce((a, l) => a + (l?.length || 0), 0)
    + nv.filter(i => !i.dismissed).length;

  return {
    ok: true,
    secured: !!opsKey(),
    registryVersion: registry.version,
    registryUpdated: registry.updated,
    slackConfigured: !!process.env.SLACK_OPS_WEBHOOK,
    bots: botViews,
    runs,
    rejected: rejectedByBot,
    social: social || null,
    socialApproved: overrides.socialApproved || [],
    needsVerification: nv,
    reviewQueueSize,
    generatedAt: new Date().toISOString(),
  };
}

/* ---- Review actions ---- */

async function approveRejected(botId, ts) {
  const rejected = (await blobGetJson(KEYS.rejected.prefix)) || {};
  const entry = (rejected[botId] || []).find(e => e.ts === ts);
  if (!entry) throw new Error('Rejected entry not found');
  const output = entry.output || {};

  if (botId === 'stories-refresh') {
    // Publish into the public AI stories archive
    const story = { ...output };
    if (!story.headline) throw new Error('Entry has no story payload to publish');
    story.id = story.id || ('ai-' + String(story.headline).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50));
    story._generated = story._generated || new Date().toISOString();
    story._approvedFromRejection = true;
    await blobUpdateJson(KEYS.stories.path, KEYS.stories.prefix, (cur) => {
      const list = Array.isArray(cur) ? cur.filter(s => s.id !== story.id) : [];
      return [story, ...list].slice(0, MAX_STORED);
    }, []);
  } else if (botId === 'story-generator') {
    // Save into the newsroom CMS as a draft
    const story = output.story || output;
    if (!story.title) throw new Error('Entry has no story payload to publish');
    story.id = story.id || `story-${Date.now()}-ops`;
    story.status = 'draft';
    story._auto = true;
    story._approvedFromRejection = true;
    await blobUpdateJson(STORIES_DB.path, STORIES_DB.prefix, (cur) => {
      const list = Array.isArray(cur) ? cur.filter(s => s.id !== story.id) : [];
      return [story, ...list];
    }, []);
  } else {
    throw new Error(`Approve not supported for bot "${botId}" — dismiss instead`);
  }

  rejected[botId] = (rejected[botId] || []).filter(e => e.ts !== ts);
  await blobPutJson(KEYS.rejected.path, KEYS.rejected.prefix, rejected);
}

async function dismissRejected(botId, ts) {
  const rejected = (await blobGetJson(KEYS.rejected.prefix)) || {};
  const before = (rejected[botId] || []).length;
  rejected[botId] = (rejected[botId] || []).filter(e => e.ts !== ts);
  if (rejected[botId].length === before) throw new Error('Rejected entry not found');
  await blobPutJson(KEYS.rejected.path, KEYS.rejected.prefix, rejected);
}

async function updateOverrides(fn) {
  await blobUpdateJson(KEYS.overrides.path, KEYS.overrides.prefix, (cur) => {
    const o = { enabled: {}, dismissedNV: [], socialApproved: [], ...(cur || {}) };
    fn(o);
    return o;
  }, {});
}

/* ---- Handler ---- */

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ops-Key');
    return res.status(204).end();
  }

  const params = new URL(req.url, 'http://localhost').searchParams;
  if (!authorized(req, params)) return json(res, { error: 'Unauthorized' }, 401);

  try {
    if (req.method === 'GET') {
      return json(res, await dashboard());
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
      if (!body?.action) return json(res, { error: 'Missing action' }, 400);

      switch (body.action) {
        case 'toggle': {
          if (!body.botId) return json(res, { error: 'Missing botId' }, 400);
          await updateOverrides(o => { o.enabled[body.botId] = !!body.enabled; });
          return json(res, { ok: true, botId: body.botId, enabled: !!body.enabled });
        }
        case 'rejected-approve':
          await approveRejected(body.botId, body.ts);
          return json(res, { ok: true });
        case 'rejected-dismiss':
          await dismissRejected(body.botId, body.ts);
          return json(res, { ok: true });
        case 'nv-dismiss':
          await updateOverrides(o => {
            if (!o.dismissedNV.includes(body.id)) o.dismissedNV.push(body.id);
          });
          return json(res, { ok: true });
        case 'social-approve':
          await updateOverrides(o => {
            const id = body.id || 'latest';
            if (!o.socialApproved.includes(id)) o.socialApproved.push(id);
          });
          return json(res, { ok: true });
        case 'social-dismiss':
          await blobUpdateJson(KEYS.social.path, KEYS.social.prefix, (cur) => ({ ...(cur || {}), dismissed: true }), {});
          return json(res, { ok: true });
        default:
          return json(res, { error: `Unknown action "${body.action}"` }, 400);
      }
    }

    return json(res, { error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('[tower/ops]', err.message);
    return json(res, { error: err.message }, 500);
  }
}
