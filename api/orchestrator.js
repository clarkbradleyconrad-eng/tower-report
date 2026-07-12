/**
 * Tower Report — /api/orchestrator
 *
 * One brain for every bot. Reads bots/registry.json (+ runtime overrides
 * from ops.html), resolves dependsOn order, runs each enabled bot with its
 * own timeout, and guarantees one bot failing never blocks the others.
 *
 * Modes:
 *   GET /api/orchestrator                    — full run of all enabled bots
 *   GET /api/orchestrator?bot=stories-refresh — run a single bot manually
 *   GET /api/orchestrator?dryRun=true        — run without publishing (no blob
 *                                              writes, no Slack, no stats)
 *   GET /api/orchestrator?forceFail=<botId>  — force one bot to fail (tests
 *                                              isolation + Slack alerting)
 *   GET /api/orchestrator?slot=watchdog      — lightweight check (GitHub
 *     Actions cron, 10:05 UTC): if no run fired since 06:00 UTC, alert Slack
 *     and run a catch-up cycle. Vercel Hobby allows only 2 crons — both are
 *     the am/pm content runs — so the watchdog lives in GitHub Actions.
 *
 * Every run writes:
 *   tower-refresh-log.json — legacy heartbeat (read by /api/health + stories.html)
 *   tower-bot-runs.json    — structured per-bot run log (status, duration,
 *                            output summary, quality score, prompt hash, errors)
 *   tower-bot-stats.json   — rolling 30-day score/duration entries per bot
 *                            per prompt version (ops.html sparklines)
 *
 * Env vars:
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob
 *   CRON_SECRET / OPS_KEY — (optional) auth; if either is set, one must match
 *   SLACK_OPS_WEBHOOK     — (optional) alerts bot target
 */

import { loadBots, orderBots } from '../bots/lib/registry.js';
import { loadFacts } from '../bots/lib/prompts.js';
import { runGrokBot } from '../bots/lib/grokbot.js';
import { runAlertsBot } from '../bots/lib/alerts.js';
import { blobGetJson, blobPutJson, KEYS } from '../bots/lib/blob.js';
import { readRepoText, baseUrl } from '../bots/lib/repo.js';

const MAX_LOGGED_RUNS = 30;
const STATS_WINDOW_MS = 30 * 24 * 3600 * 1000;
// maxDuration is 300s — leave headroom so the alerts bot + log writes always fit
const RUN_DEADLINE_MS = 275000;

/* ---- HTTP bot adapters: call the endpoint, distill a summary ----
   Endpoints return _score/_promptHash (see bots/prompts/) which flow into
   the run log. Adding a kind:"grok" bot needs NO adapter — only http bots
   that wrap pre-existing endpoints have one. */

async function stepFetch(base, pathAndQuery, init = {}, timeoutMs) {
  const secret = process.env.CRON_SECRET;
  const headers = {
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    ...(init.headers || {}),
  };
  const res = await fetch(`${base}${pathAndQuery}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch { return { raw: body.slice(0, 200) }; }
}

function withQuery(endpoint, extra) {
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${extra}`;
}

const HTTP_ADAPTERS = {
  briefing: async (bot, { base, dryRun }) => {
    const url = dryRun ? withQuery(bot.endpoint, 'dryRun=1') : bot.endpoint;
    const data = await stepFetch(base, url, {}, bot.timeoutMs);
    return {
      score: data._score ?? null,
      promptHash: data._promptHash ?? null,
      rejected: !!data.rejected,
      summary: { items: Array.isArray(data.briefing) ? data.briefing.length : 0, stale: !!data.stale, ...(data.rejected ? { rejected: true } : {}) },
    };
  },

  'story-generator': async (bot, { base, dryRun }) => {
    const url = dryRun ? withQuery(bot.endpoint, 'dryRun=1') : bot.endpoint;
    let gen;
    try {
      gen = await stepFetch(base, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'Program News',
          topic: 'The single most important verified Texas Longhorns football development of the last 24 hours',
        }),
      }, bot.timeoutMs);
    } catch (err) {
      // A 422 gate rejection is a successful bot run whose output didn't
      // make the bar — it's already in the review queue, not a failure
      if (/STORY_REJECTED/.test(err.message)) {
        const m = err.message.match(/HTTP 422: (\{.*)/s);
        let body = {};
        try { body = JSON.parse(m ? m[1] : '{}'); } catch { /* partial body */ }
        return { score: body._score ?? null, promptHash: body._promptHash ?? null, rejected: true, summary: { rejected: true, headline: body.headline || null, reasons: (body.reasons || [String(err.message).slice(0, 160)]).slice(0, 4) } };
      }
      throw err;
    }
    if (gen.code === 'STORY_REJECTED' || gen.rejected) {
      return { score: gen._score ?? null, promptHash: gen._promptHash ?? null, rejected: true, summary: { rejected: true, headline: gen.headline, reasons: (gen.reasons || []).slice(0, 4) } };
    }
    if (!gen.story?.id) throw new Error('generate-story returned no story');

    if (!dryRun) {
      const story = { ...gen.story, _auto: true };
      // Drop older auto drafts so the newsroom stays clean, then save the new one
      try {
        const db = await stepFetch(base, '/api/stories-db', {}, 15000);
        const stale = (db.stories || []).filter(s => s._auto && s.status === 'draft' && s.id !== story.id);
        for (const s of stale.slice(0, 5)) {
          await stepFetch(base, `/api/stories-db?id=${encodeURIComponent(s.id)}`, { method: 'DELETE' }, 15000);
        }
      } catch (err) {
        console.warn('[tower/orchestrator] auto-draft cleanup skipped:', err.message);
      }
      await stepFetch(base, '/api/stories-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story }),
      }, 15000);
    }
    return {
      score: gen._score ?? null,
      promptHash: gen._promptHash ?? null,
      summary: { draftId: gen.story.id, title: gen.story.title, ...(dryRun ? { dryRun: true, notSaved: true } : {}) },
    };
  },

  'stories-refresh': async (bot, { base, dryRun }) => {
    const secret = process.env.CRON_SECRET;
    let url = bot.endpoint + (secret ? `${bot.endpoint.includes('?') ? '&' : '?'}token=${encodeURIComponent(secret)}` : '');
    if (dryRun) url = withQuery(url, 'dryRun=1');
    const data = await stepFetch(base, url, {}, bot.timeoutMs);
    return {
      score: data._score ?? null,
      promptHash: data._promptHash ?? null,
      summary: {
        added: data.added,
        droppedDuplicates: data.droppedDuplicates,
        rejected: data.rejected,
        rejectedDetail: (data.rejectedDetail || []).map(r => ({ headline: r.headline, reasons: (r.reasons || []).join('; ').slice(0, 200) })),
        total: data.total,
      },
    };
  },

  'verify-recruiting': async (bot, { base, dryRun }) => {
    const secret = process.env.CRON_SECRET;
    let url = bot.endpoint + (secret ? `&token=${encodeURIComponent(secret)}` : '');
    if (dryRun) url = withQuery(url, 'dryRun=1');
    const data = await stepFetch(base, url, {}, bot.timeoutMs);
    return {
      score: data._score ?? null,
      promptHash: data._promptHash ?? null,
      summary: {
        on3Rank: data.live?.on3TeamRank ?? null,
        sports247Rank: data.live?.sports247TeamRank ?? null,
        commits: data.live?.commitCount ?? null,
        sources: (data.live?.sources || []).length,
      },
    };
  },

  odds: async (bot, { base }) => {
    const data = await stepFetch(base, bot.endpoint, {}, bot.timeoutMs);
    return { summary: { source: data.meta?.source, liveGames: data.meta?.liveGames } };
  },
};

/* ---- Review queue size (for the alerts bot) ---- */

async function reviewQueueSize(overrides) {
  let total = 0;
  try {
    const rejected = (await blobGetJson(KEYS.rejected.prefix)) || {};
    for (const list of Object.values(rejected)) total += Array.isArray(list) ? list.length : 0;
  } catch { /* queue unavailable ≠ run failure */ }
  try {
    const nv = await readRepoText('NEEDS-VERIFICATION.md');
    if (nv) {
      const items = (nv.match(/^## /gm) || []).length;
      total += Math.max(0, items - (overrides.dismissedNV || []).length);
    }
  } catch { /* ignore */ }
  return total;
}

/* ---- One bot, fully isolated ---- */

async function runBot(bot, ctx) {
  const started = Date.now();
  try {
    if (ctx.forceFail === bot.id) {
      throw new Error('Forced failure via ?forceFail= (isolation/alert test)');
    }
    let out;
    if (bot.kind === 'http') {
      const adapter = HTTP_ADAPTERS[bot.id];
      if (!adapter) throw new Error(`No adapter for http bot "${bot.id}"`);
      out = await adapter(bot, ctx);
    } else if (bot.kind === 'grok') {
      out = await runGrokBot(bot, { facts: ctx.facts, dryRun: ctx.dryRun });
    } else if (bot.kind === 'internal' && bot.module === 'alerts') {
      out = await runAlertsBot(ctx.alertsCtx(), { dryRun: ctx.dryRun });
    } else {
      throw new Error(`Unknown bot kind "${bot.kind}"`);
    }
    const ms = Date.now() - started;
    console.log(`[tower/orchestrator] bot=${bot.id} ok ms=${ms} score=${out.score ?? '-'}`);
    return {
      id: bot.id, name: bot.name, ok: true, ms,
      score: out.score ?? null, promptHash: out.promptHash ?? null,
      rejected: !!out.rejected, summary: out.summary || null, alert: bot.alert || null,
    };
  } catch (err) {
    const ms = Date.now() - started;
    console.error(`[tower/orchestrator] bot=${bot.id} FAILED ms=${ms}: ${err.message}`);
    return {
      id: bot.id, name: bot.name, ok: false, ms,
      error: String(err.message).slice(0, 300), alert: bot.alert || null,
    };
  }
}

/* ---- Persistence ---- */

async function writeHeartbeat(run, results) {
  const log = (await blobGetJson(KEYS.heartbeat.prefix)) || { lastRun: null, lastSuccess: {}, runs: [] };
  log.lastRun = run.finishedAt;
  const steps = results.filter(r => !r.skipped).map(r => ({
    name: r.legacyName || r.id,
    ok: r.ok, ms: r.ms,
    ...(r.ok ? { detail: r.summary } : { error: r.error }),
  }));
  for (const s of steps) if (s.ok) log.lastSuccess[s.name] = run.finishedAt;
  log.runs = [{ startedAt: run.startedAt, finishedAt: run.finishedAt, trigger: run.trigger, steps }, ...(log.runs || [])].slice(0, MAX_LOGGED_RUNS);
  await blobPutJson(KEYS.heartbeat.path, KEYS.heartbeat.prefix, log);
}

async function writeRunLog(run) {
  const log = (await blobGetJson(KEYS.runs.prefix)) || { runs: [] };
  log.runs = [run, ...(log.runs || [])].slice(0, MAX_LOGGED_RUNS);
  await blobPutJson(KEYS.runs.path, KEYS.runs.prefix, log);
}

async function updateStats(results, statsBefore) {
  const stats = statsBefore && typeof statsBefore === 'object' ? { ...statsBefore } : {};
  const cutoff = Date.now() - STATS_WINDOW_MS;
  const now = new Date().toISOString();
  for (const r of results) {
    if (r.skipped || r.id === 'alerts') continue;
    stats[r.id] = [
      { t: now, score: r.score ?? null, ok: r.ok, ms: r.ms, promptHash: r.promptHash ?? null },
      ...(stats[r.id] || []),
    ].filter(e => new Date(e.t).getTime() >= cutoff).slice(0, 120);
  }
  await blobPutJson(KEYS.stats.path, KEYS.stats.prefix, stats);
  return stats;
}

/* ---- Handler ---- */

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const params = new URL(req.url, 'http://localhost').searchParams;
  const secret = process.env.CRON_SECRET;
  const opsKey = process.env.OPS_KEY;
  if (secret || opsKey) {
    const bearer = req.headers['authorization'] || '';
    const token = params.get('token') || params.get('key') || '';
    const okSecret = secret && (bearer === `Bearer ${secret}` || token === secret);
    const okOps = opsKey && (token === opsKey || req.headers['x-ops-key'] === opsKey);
    // Vercel cron requests carry x-vercel-cron; without CRON_SECRET set they
    // have no way to authenticate, so accept them explicitly.
    const okCronHeader = !!req.headers['x-vercel-cron'];
    if (!okSecret && !okOps && !okCronHeader) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const singleBot = params.get('bot');
  const dryRun = ['true', '1'].includes(params.get('dryRun') || '');
  const forceFail = params.get('forceFail') || null;
  const slot = params.get('slot') || null;

  const isCron = !!req.headers['x-vercel-cron'] || /vercel-cron/i.test(req.headers['user-agent'] || '');
  const trigger = slot === 'watchdog' ? 'watchdog' : isCron ? `cron-${slot || 'daily'}` : singleBot ? 'manual-single' : 'manual';

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const base = baseUrl();

  // Watchdog: no run in the last 13h means a scheduled slot was missed
  // (06:00 checked at ~10:05, 18:00 checked at ~22:05) → alert + catch up.
  // Rolling window instead of "since 06:00 UTC" so both slots are covered.
  let watchdogMiss = null;
  if (slot === 'watchdog') {
    const heartbeat = await blobGetJson(KEYS.heartbeat.prefix);
    const lastRun = heartbeat?.lastRun ? new Date(heartbeat.lastRun) : null;
    const freshMs = 13 * 3600 * 1000;
    if (lastRun && Date.now() - lastRun.getTime() < freshMs) {
      return res.status(200).json({ ok: true, watchdog: 'pass', lastRun: heartbeat.lastRun });
    }
    watchdogMiss = { lastRun: heartbeat?.lastRun || null };
    console.warn('[tower/orchestrator] watchdog MISS — no run in 13h, running catch-up');
  }

  const { bots, overrides } = await loadBots();
  const facts = await loadFacts();
  const statsBefore = (await blobGetJson(KEYS.stats.prefix)) || {};
  const queueSize = await reviewQueueSize(overrides);

  let toRun;
  if (singleBot) {
    const bot = bots.find(b => b.id === singleBot);
    if (!bot) return res.status(404).json({ error: `Unknown bot "${singleBot}" — see bots/registry.json` });
    // Manual single-bot triggers run even when the bot is disabled; alerts
    // still evaluates afterwards so a failing manual run tattles too.
    const alertsBot = bots.find(b => b.id === 'alerts' && b.enabled);
    toRun = bot.id === 'alerts' ? [bot] : [bot, ...(alertsBot ? [alertsBot] : [])];
  } else {
    toRun = orderBots(bots.filter(b => b.enabled));
  }

  const results = [];
  const ctx = {
    base, dryRun, forceFail, facts,
    alertsCtx: () => ({
      results: results.filter(r => r.id !== 'alerts'),
      stats: statsBefore,
      reviewQueueSize: singleBot ? 0 : queueSize, // queue alert only on full runs
      watchdogMiss,
    }),
  };

  const deadline = startMs + RUN_DEADLINE_MS;
  for (const bot of toRun) {
    if (bot.id !== 'alerts' && Date.now() + (bot.timeoutMs || 60000) > deadline) {
      console.warn(`[tower/orchestrator] bot=${bot.id} skipped (run time budget)`);
      results.push({ id: bot.id, name: bot.name, skipped: true, reason: 'time budget exhausted' });
      continue;
    }
    const r = await runBot(bot, ctx);
    r.legacyName = bot.legacyName;
    results.push(r);
  }

  const finishedAt = new Date().toISOString();
  const run = {
    runId: `run-${startedAt.replace(/[:.]/g, '-')}`,
    startedAt, finishedAt, trigger, dryRun,
    ...(forceFail ? { forceFail } : {}),
    ...(watchdogMiss ? { watchdogMiss } : {}),
    bots: results.map(({ legacyName, alert, ...r }) => r),
  };

  // Persist logs + stats — never on dry runs
  let logsOk = true;
  if (!dryRun) {
    try {
      await writeHeartbeat(run, results);
      await updateStats(results, statsBefore);
    } catch (err) {
      logsOk = false;
      console.error('[tower/orchestrator] heartbeat/stats write failed:', err.message);
    }
  }
  try {
    await writeRunLog(run); // dry runs land in the run log too, flagged dryRun
  } catch (err) {
    logsOk = false;
    console.error('[tower/orchestrator] run log write failed:', err.message);
  }

  const ran = results.filter(r => !r.skipped);
  const allOk = ran.every(r => r.ok);
  console.log(`[tower/orchestrator] done ok=${allOk} trigger=${trigger} bots=${ran.map(r => `${r.id}:${r.ok ? 'ok' : 'FAIL'}(${r.ms}ms${r.score != null ? ` s${r.score}` : ''})`).join(' ')}`);
  return res.status(200).json({ ok: allOk, logsOk, ...run });
}
