/**
 * Tower Report — /api/telegram
 *
 * Two-way Telegram bot. Receives webhook POSTs from Telegram and dispatches
 * to command handlers. All security enforced before any logic runs.
 *
 * Security:
 *   1. X-Telegram-Bot-Api-Secret-Token header must match TELEGRAM_WEBHOOK_SECRET
 *   2. Only TELEGRAM_CHAT_ID receives replies — all others get total silence
 *   3. Write actions require a second confirm tap (inline keyboard)
 *   4. Commands map to a fixed allowlist — no eval, no shell
 *   5. Max 30 commands/hour; excess pauses and notifies
 *   6. Every command logged to Supabase tg_audit_log
 */

import { blobGetJson, blobPutJson } from '../bots/lib/blob.js';

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_KEY = 'tower-tg-ratelimit';
const PENDING_KEY    = 'tower-tg-pending';
const PENDING_TTL_MS = 5 * 60 * 1000;
const BASE           = 'https://tower-report.vercel.app';

// ── Telegram API ──────────────────────────────────────────────────────────────

async function tgPost(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return res.json();
}

async function reply(chatId, text, extra = {}) {
  return tgPost('sendMessage', {
    chat_id:    chatId,
    text:       String(text).slice(0, 4096),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

async function replyConfirm(chatId, text, actionKey) {
  return reply(chatId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✓ Confirm', callback_data: `confirm:${actionKey}` },
        { text: '✗ Cancel',  callback_data: 'cancel' },
      ]],
    },
  });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return tgPost('editMessageText', {
    chat_id:    chatId,
    message_id: messageId,
    text:       String(text).slice(0, 4096),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

async function answerCbq(id, text = '') {
  return tgPost('answerCallbackQuery', { callback_query_id: id, text });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function checkRateLimit() {
  try {
    const now    = Date.now();
    const stored = (await blobGetJson(RATE_LIMIT_KEY)) || {};
    const start  = stored.windowStart || 0;
    const count  = stored.count || 0;
    if (now - start > 3_600_000) {
      await blobPutJson(`${RATE_LIMIT_KEY}.json`, RATE_LIMIT_KEY, { windowStart: now, count: 1 });
      return true;
    }
    if (count >= RATE_LIMIT_MAX) return false;
    await blobPutJson(`${RATE_LIMIT_KEY}.json`, RATE_LIMIT_KEY, { windowStart: start, count: count + 1 });
    return true;
  } catch { return true; }
}

// ── Pending confirmations ─────────────────────────────────────────────────────

async function savePending(action) {
  await blobPutJson(`${PENDING_KEY}.json`, PENDING_KEY, {
    ...action,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  });
}

async function loadPending() {
  const p = await blobGetJson(PENDING_KEY).catch(() => null);
  if (!p) return null;
  if (new Date(p.expiresAt).getTime() < Date.now()) return null;
  return p;
}

async function clearPending() {
  await blobPutJson(`${PENDING_KEY}.json`, PENDING_KEY, null).catch(() => {});
}

// ── Audit log ─────────────────────────────────────────────────────────────────

async function audit(chatId, command, params, outcome, ok = true) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/tg_audit_log`, {
      method:  'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ chat_id: String(chatId), command, params: params || null, outcome: outcome || null, ok }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) { console.error('[telegram] audit log failed:', err.message); }
}

// ── Internal API helpers ──────────────────────────────────────────────────────

async function internalGet(path) {
  const opsKey = process.env.OPS_KEY || '';
  const sep    = path.includes('?') ? '&' : '?';
  const url    = `${BASE}${path}${opsKey ? `${sep}key=${encodeURIComponent(opsKey)}` : ''}`;
  const res    = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

// ── Grok helper ───────────────────────────────────────────────────────────────

async function grokAsk(prompt, { webSearch = false, maxTokens = 400 } = {}) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');
  const body = { model: 'grok-4', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: maxTokens };
  if (webSearch) { body.tools = [{ type: 'web_search_preview' }]; body.tool_choice = 'auto'; }
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Grok API ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── NLP router ────────────────────────────────────────────────────────────────

const NLP_KEYWORDS = [
  { cmd: 'status',    words: ['status','health','system','pipeline running','how are we','how is it','everything ok','all good','what happened','last run'] },
  { cmd: 'stories',   words: ['stories','story','articles','article','what do we have','what\'s written','what have we got','new stories','latest stories','show stories','see stories','any stories'] },
  { cmd: 'queue',     words: ['queue','tweets','tweet','x post','x posts','pending posts','what\'s pending','posting','what\'s in the queue','ready to post','what to post'] },
  { cmd: 'bots',      words: ['bots','when did','bot run','last ran','pipeline steps'] },
  { cmd: 'audit',     words: ['audit','log','history','recent commands','what have i done','command history'] },
  { cmd: 'run',       words: ['run pipeline','run it','trigger','start pipeline','fire it','run the bots','run everything','refresh everything','run now','kick it off'] },
  { cmd: 'idea',      words: ['idea','suggest','pitch','what if we wrote','story idea','story about','we should write','cover this'] },
  { cmd: 'kill',      words: ['kill','remove story','drop story','delete story','get rid of','trash that'] },
  { cmd: 'post',      words: ['post it','send tweet','tweet it','publish tweet','post tweet','fire tweet','send it','post this'] },
  { cmd: 'check',     words: ['check','verify','confirm','did he','did they','is it true','recruits','commit','portal','decommit','what\'s the latest on','any news on','where does'] },
  { cmd: 'dashboard', words: ['hi','hey','hello','sup','what\'s up','whats up','home','main','overview','what\'s going on','what do i need'] },
];

async function nlpRoute(text) {
  const lower = text.toLowerCase();
  for (const { cmd, words } of NLP_KEYWORDS) {
    if (words.some(w => lower.includes(w))) return { cmd, args: '' };
  }

  try {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { cmd: 'dashboard', args: '' };
    const prompt = `Route this to a Texas Longhorns football bot command.
Commands: status, stories, queue, bots, audit, run, kill, post, idea, check, dashboard
Message: "${text.slice(0, 200)}"
JSON only: {"cmd":"status","args":""}`;
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'grok-4', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 40 }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    const m = (data.choices?.[0]?.message?.content || '').match(/\{[^}]+\}/);
    if (m) return JSON.parse(m[0]);
  } catch { /* fall through */ }

  return { cmd: 'dashboard', args: '' };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function timeAgo(iso) {
  if (!iso) return 'never';
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function ctTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
  });
}

// ── Action executors ──────────────────────────────────────────────────────────

async function executePost(chatId, messageId, data) {
  try {
    // Approve the queue item
    await fetch(`${BASE}/api/x-queue`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-ops-key': process.env.OPS_KEY || '' },
      body: JSON.stringify({ id: data.id, status: 'approved' }),
      signal: AbortSignal.timeout(8000),
    });

    // Trigger social-post
    const secret = process.env.CRON_SECRET;
    const postRes = await fetch(`${BASE}/api/social-post${secret ? `?token=${encodeURIComponent(secret)}` : ''}`, {
      signal: AbortSignal.timeout(25000),
    });
    const result = await postRes.json();
    const tweetUrl = result.results?.[0]?.url;

    if (tweetUrl) {
      await editMessage(chatId, messageId, `✓ <b>Posted.</b>\n\n${tweetUrl}`, { link_preview_options: { is_disabled: false } });
    } else if (result.posted > 0) {
      await editMessage(chatId, messageId, '✓ Posted to @towerreportai.');
    } else {
      await editMessage(chatId, messageId, `Sent, but no tweet URL returned.\n${result.message || 'Check X dashboard.'}`);
    }
  } catch (err) {
    await editMessage(chatId, messageId, `Error posting: ${err.message}`);
  }
}

async function executeKill(chatId, messageId, data) {
  try {
    const blob = await blobGetJson('tower-ai-stories');
    const isArr = Array.isArray(blob);
    const all = isArr ? blob : (blob?.stories || []);

    const updated = all.map(s => s.headline === data.headline
      ? { ...s, rejected: true, rejectedReason: 'killed-by-operator', rejectedAt: new Date().toISOString() }
      : s
    );

    await blobPutJson('tower-ai-stories.json', 'tower-ai-stories', isArr ? updated : { ...blob, stories: updated });
    await editMessage(chatId, messageId, `✓ <b>Killed.</b>\n\n"${(data.headline || '').slice(0, 80)}" removed from pipeline.`);
  } catch (err) {
    await editMessage(chatId, messageId, `Error killing story: ${err.message}`);
  }
}

async function executeRun(chatId, messageId, data) {
  // Fire-and-forget — orchestrator takes up to 5 min, telegram fn limit is 30s
  await editMessage(chatId, messageId, '⏳ Pipeline running. Text /status in ~5 minutes to see results.');
  const path = data.bot === 'all' ? '/api/orchestrator' : `/api/orchestrator?bot=${encodeURIComponent(data.bot)}`;
  const opsKey = process.env.OPS_KEY || '';
  const sep = path.includes('?') ? '&' : '?';
  fetch(`${BASE}${path}${opsKey ? `${sep}key=${encodeURIComponent(opsKey)}` : ''}`)
    .catch(err => console.error('[telegram] orchestrator fire:', err.message));
}

// ── Smart dashboard ───────────────────────────────────────────────────────────

async function showDashboard(chatId) {
  const [health, queueData, storiesBlob] = await Promise.allSettled([
    internalGet('/api/health'),
    internalGet('/api/x-queue'),
    blobGetJson('tower-ai-stories'),
  ]);

  const h  = health.status === 'fulfilled' ? health.value : null;
  const q  = queueData.status === 'fulfilled' ? queueData.value : null;
  const sb = storiesBlob.status === 'fulfilled' ? storiesBlob.value : null;

  const lastRunMs       = h?.lastRun ? new Date(h.lastRun).getTime() : 0;
  const hoursSince      = lastRunMs ? (Date.now() - lastRunMs) / 3_600_000 : null;
  const pendingPosts    = (q?.items || []).filter(i => i.status === 'pending').length;
  const allStories      = Array.isArray(sb) ? sb : (sb?.stories || []);
  const activeStories   = allStories.filter(s => !s.rejected).length;
  const rejectedStories = allStories.filter(s => s.rejected).length;
  const published       = allStories.filter(s => !s.rejected && s.published).length;

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
  let msg = `<b>Tower Report · ${date}</b>\n\n`;

  // State
  msg += `Pipeline: ${h?.lastRun ? timeAgo(h.lastRun) : 'never'}\n`;
  msg += `Stories: ${activeStories} active`;
  if (published) msg += ` (${published} published)`;
  if (rejectedStories) msg += `, ${rejectedStories} rejected`;
  msg += '\n';
  msg += `X queue: ${pendingPosts} pending\n`;

  // Nudges — what actually needs attention
  const nudges = [];
  if (hoursSince !== null && hoursSince > 8) nudges.push(`⚠️ Pipeline stale (${Math.round(hoursSince)}h) — /run to refresh`);
  if (pendingPosts > 0) nudges.push(`→ ${pendingPosts} post${pendingPosts > 1 ? 's' : ''} ready to send — /queue`);
  if (activeStories === 0) nudges.push('→ No stories in pipeline — /run to pull new ones');
  if (activeStories > 0 && pendingPosts === 0) nudges.push('→ /stories to review what\'s in the pipeline');

  if (nudges.length) {
    msg += '\n' + nudges.join('\n');
  }

  await reply(chatId, msg);
}

// ── Command handlers ──────────────────────────────────────────────────────────

const HANDLERS = {

  start: async (chatId) => {
    await showDashboard(chatId);
    return 'started';
  },

  dashboard: async (chatId) => {
    await showDashboard(chatId);
    return 'ok';
  },

  status: async (chatId) => {
    const health = await internalGet('/api/health');
    let msg = '<b>System Status</b>\n\n';
    msg += `Pipeline: ${timeAgo(health.lastRun)}\n`;
    const q = health.quality;
    if (q) {
      msg += `Added: ${q.storiesAdded ?? 0}  Dropped: ${q.duplicatesDropped ?? 0}`;
      if (q.storiesRejected) msg += `  Rejected: ${q.storiesRejected}`;
      msg += '\n';
      if (q.rejectedDetail?.length) {
        msg += '\nRejected:\n';
        q.rejectedDetail.slice(0, 3).forEach(r => {
          msg += `  • ${(r.headline || '?').slice(0, 60)} (${r.reason || '?'})\n`;
        });
      }
    }
    const stepNames = { 'stories-refresh': 'Story Scout', 'briefing': 'Briefing Writer', 'x-generate': 'X Writer', 'verify-recruiting': 'Recruiter', 'social-post': 'Social Poster' };
    const steps = Object.entries(health.lastSuccess || {}).map(([k, v]) => `  ${stepNames[k] || k}: ${timeAgo(v)}`).join('\n');
    if (steps) msg += `\n<b>Steps:</b>\n${steps}`;
    if (!health.ok && health.error) msg += `\n\nError: ${health.error}`;
    await reply(chatId, msg);
    return 'ok';
  },

  stories: async (chatId) => {
    const blob   = await blobGetJson('tower-ai-stories');
    const all    = Array.isArray(blob) ? blob : (blob?.stories || []);
    const active = all.filter(s => !s.rejected).sort((a, b) => (b.score || 0) - (a.score || 0));

    if (!active.length) {
      await reply(chatId, 'No stories in the pipeline. Text "run the pipeline" to refresh.');
      return 'ok';
    }

    let msg = `<b>Stories (${active.length})</b>\n\n`;
    const buttons = [];

    active.slice(0, 5).forEach((s, i) => {
      msg += `${i + 1}. <b>${s.headline || '?'}</b>${s.published ? ' ✓' : ''}\n`;
      msg += `   Score ${s.score ?? '?'} · ${s.category || 'general'}\n`;
      if (s.hook) msg += `   ${s.hook.slice(0, 80)}\n`;
      msg += '\n';
      if (!s.published) buttons.push([{ text: `🗑 Kill ${i + 1}`, callback_data: `ks:${i}` }]);
    });

    if (all.filter(s => s.rejected).length) {
      const rejected = all.filter(s => s.rejected).slice(0, 3);
      msg += '<b>Rejected:</b>\n';
      rejected.forEach(s => { msg += `  • ${(s.headline || '?').slice(0, 60)}\n`; });
    }

    await reply(chatId, msg.trim(), buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
    return 'ok';
  },

  queue: async (chatId) => {
    const data    = await internalGet('/api/x-queue');
    const items   = data.items || [];
    const pending = items.filter(i => i.status === 'pending');
    const posted  = items.filter(i => i.status === 'posted').slice(0, 3);

    if (!pending.length && !posted.length) {
      await reply(chatId, 'X queue is empty.\n\nText "run the pipeline" to generate posts, or /run to trigger manually.');
      return 'ok';
    }

    let msg = '';
    const buttons = [];

    if (pending.length) {
      msg += `<b>Pending (${pending.length})</b>\n\n`;
      pending.slice(0, 5).forEach((item, i) => {
        msg += `${i + 1}. ${(item.text || '?').slice(0, 220)}\n\n`;
        buttons.push([{ text: `📤 Post ${i + 1}`, callback_data: `qi:${(item.id || '').slice(0, 55)}` }]);
      });
    }

    if (posted.length) {
      msg += '<b>Recently posted:</b>\n';
      posted.forEach(item => { msg += `  ✓ ${(item.text || '?').slice(0, 80)}…\n`; });
    }

    await reply(chatId, msg.trim(), buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
    return 'ok';
  },

  bots: async (chatId) => {
    const health = await internalGet('/api/health');
    const names  = { 'stories-refresh': 'Story Scout', 'briefing': 'Briefing Writer', 'x-generate': 'X Writer', 'verify-recruiting': 'Recruiter', 'social-post': 'Social Poster' };
    let msg = '<b>Bot Run Times</b>\n\n';
    const entries = Object.entries(health.lastSuccess || {});
    if (!entries.length) {
      msg += 'No run data yet.';
    } else {
      entries.forEach(([k, v]) => {
        msg += `${names[k] || k}: ${timeAgo(v)}\n`;
        if (v) msg += `  ${ctTime(v)}\n`;
      });
    }
    msg += `\nPipeline: ${timeAgo(health.lastRun)}`;
    if (health.latestRun?.slot) msg += ` (${health.latestRun.slot})`;
    await reply(chatId, msg);
    return 'ok';
  },

  audit: async (chatId) => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) { await reply(chatId, 'Audit log not configured.'); return 'error'; }
    const r = await fetch(`${url}/rest/v1/tg_audit_log?order=ts.desc&limit=15`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
    });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) { await reply(chatId, 'No audit log entries yet.'); return 'ok'; }
    let msg = '<b>Recent Commands</b>\n\n';
    rows.forEach(row => {
      msg += `${row.ok ? '✓' : '✗'} <code>${row.command}</code>`;
      if (row.params) msg += ` ${row.params.slice(0, 40)}`;
      msg += ` — ${ctTime(row.ts)}\n`;
    });
    await reply(chatId, msg.trim());
    return 'ok';
  },

  run: async (chatId, args) => {
    const bot = (args || '').trim() || 'all';
    const key = `run-${Date.now()}`;
    await savePending({ actionKey: key, action: 'run', data: { bot }, description: bot === 'all' ? 'Full pipeline run' : `Run ${bot}` });
    const msg = bot === 'all'
      ? 'Run the full pipeline?\n\nRefreshes stories, briefing, and X posts. Takes ~5 minutes.'
      : `Run <b>${bot}</b> bot now?`;
    await replyConfirm(chatId, msg, key);
    return 'ok';
  },

  post: async (chatId, args) => {
    const data = await internalGet('/api/x-queue');
    const pending = (data.items || []).filter(i => i.status === 'pending');

    if (!pending.length) {
      await reply(chatId, 'No pending posts in the queue.\n\nText "run the pipeline" to generate some.');
      return 'ok';
    }

    // If a number was given, confirm that specific one
    const idx = parseInt(args) - 1;
    const item = pending[isNaN(idx) ? 0 : idx] || pending[0];
    const key  = `post-${item.id}`;

    await savePending({ actionKey: key, action: 'post', data: { id: item.id }, description: 'Post to @towerreportai' });
    await replyConfirm(chatId, `Post this to <b>@towerreportai</b>?\n\n${item.text}`, key);
    return 'ok';
  },

  kill: async (chatId, args) => {
    const blob   = await blobGetJson('tower-ai-stories');
    const all    = Array.isArray(blob) ? blob : (blob?.stories || []);
    const active = all.filter(s => !s.rejected).sort((a, b) => (b.score || 0) - (a.score || 0));

    if (!active.length) { await reply(chatId, 'No active stories to kill.'); return 'ok'; }

    // If a number argument, kill that one directly
    const idx = parseInt(args) - 1;
    if (!isNaN(idx) && active[idx]) {
      const story = active[idx];
      const key   = `kill-${Date.now()}`;
      await savePending({ actionKey: key, action: 'kill', data: { headline: story.headline }, description: `Kill "${(story.headline || '').slice(0, 50)}"` });
      await replyConfirm(chatId, `Kill this story?\n\n<b>${story.headline}</b>`, key);
      return 'ok';
    }

    // Otherwise show list with buttons
    let msg = '<b>Which story to kill?</b>\n\n';
    const buttons = [];
    active.slice(0, 5).forEach((s, i) => {
      msg += `${i + 1}. ${(s.headline || '?').slice(0, 80)}\n`;
      buttons.push([{ text: `🗑 Kill ${i + 1}`, callback_data: `ks:${i}` }]);
    });
    await reply(chatId, msg.trim(), { reply_markup: { inline_keyboard: buttons } });
    return 'ok';
  },

  idea: async (chatId, args) => {
    if (!args) {
      await reply(chatId, 'What\'s the idea?\n\nExample: /idea Sark press conference — what he said about the OL\nOr just text: "idea: [your pitch]"');
      return 'ok';
    }
    try {
      const ideas = (await blobGetJson('tower-story-ideas').catch(() => [])) || [];
      ideas.unshift({ idea: args, submittedAt: new Date().toISOString() });
      await blobPutJson('tower-story-ideas.json', 'tower-story-ideas', ideas.slice(0, 50));
      await reply(chatId, `✓ Saved.\n\n"${args.slice(0, 100)}"\n\nThe pipeline will pick this up next run.`);
    } catch (err) {
      await reply(chatId, `Error saving: ${err.message}`);
    }
    return 'ok';
  },

  check: async (chatId, args) => {
    if (!args) {
      await reply(chatId, 'What do you want to check?\n\nExample: /check did [player] decommit\nOr just text it naturally.');
      return 'ok';
    }
    await reply(chatId, `Checking: <i>${args.slice(0, 100)}</i>…`);
    const prompt = `You are a Texas Longhorns football recruiting and news expert. Answer this question using the most current information available. Be direct and concise (under 150 words). If you're not certain, say so.\n\nQuestion: ${args}`;
    const answer = await grokAsk(prompt, { webSearch: true, maxTokens: 300 });
    await reply(chatId, answer || 'No answer from Grok.');
    return 'ok';
  },

  subs:    async (chatId) => { await reply(chatId, 'Check resend.com/audiences for subscriber counts — not exposed via API yet.'); return 'ok'; },
  traffic: async (chatId) => { await reply(chatId, 'Enable Vercel Analytics in the dashboard first: tower-report.vercel.app → Analytics → Enable.'); return 'ok'; },
  correct: async (chatId) => { await reply(chatId, '⏳ /correct — coming in a future update.'); return 'stub'; },
  fix:     async (chatId) => { await reply(chatId, '⏳ /fix — coming in a future update.'); return 'stub'; },
  verify:  async (chatId) => { await reply(chatId, '⏳ /verify — coming in a future update.'); return 'stub'; },
  pause:   async (chatId) => { await reply(chatId, '⏳ /pause — coming in a future update.'); return 'stub'; },
  resume:  async (chatId) => { await reply(chatId, '⏳ /resume — coming in a future update.'); return 'stub'; },
  deploy:  async (chatId) => { await reply(chatId, '⏳ /deploy — coming in a future update.'); return 'stub'; },

  help: async (chatId) => {
    await reply(chatId,
      '<b>Commands</b>\n\n' +
      '/status — system health\n' +
      '/stories — pipeline stories (with Kill buttons)\n' +
      '/queue — X posts pending (with Post buttons)\n' +
      '/bots — last bot run times\n' +
      '/audit — recent commands\n' +
      '/run — trigger the pipeline\n' +
      '/post [n] — post a specific tweet\n' +
      '/kill [n] — kill a story\n' +
      '/idea [text] — save a story idea\n' +
      '/check [topic] — fact-check anything\n\n' +
      'Or just text normally — "what stories do we have?", "post tweet 2", etc.'
    );
    return 'ok';
  },
};

// ── Message router ────────────────────────────────────────────────────────────

async function handleMessage(message, chatId) {
  const text = (message.text || '').trim();
  if (!text) return;

  if (!text.startsWith('/')) {
    const { cmd, args } = await nlpRoute(text);
    const handler = HANDLERS[cmd] || HANDLERS.dashboard;
    let outcome = 'ok';
    try {
      outcome = (await handler(chatId, args || text)) ?? 'ok';
    } catch (err) {
      await reply(chatId, `Error: ${err.message}`);
      outcome = `error: ${err.message.slice(0, 200)}`;
    }
    await audit(chatId, `nlp→${cmd}`, text.slice(0, 100), outcome, !outcome.startsWith('error'));
    return;
  }

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd  = rawCmd.slice(1).replace(/@\w+$/, '').toLowerCase();
  const args = rest.join(' ');

  const handler = HANDLERS[cmd];
  if (!handler) {
    const available = ['status','stories','queue','bots','audit','run','post','kill','idea','check'].map(c => `/${c}`).join(' ');
    await reply(chatId, `Unknown: /${cmd}\n\nAvailable: ${available}`);
    await audit(chatId, `/${cmd}`, args || null, 'unknown', false);
    return;
  }

  let outcome = 'ok';
  try {
    outcome = (await handler(chatId, args)) ?? 'ok';
  } catch (err) {
    await reply(chatId, `Error in /${cmd}: ${err.message}`);
    outcome = `error: ${err.message.slice(0, 200)}`;
    await audit(chatId, `/${cmd}`, args || null, outcome, false);
    return;
  }
  await audit(chatId, `/${cmd}`, args || null, outcome);
}

// ── Callback router ───────────────────────────────────────────────────────────

async function handleCallback(cbq, chatId) {
  const data = cbq.data || '';
  await answerCbq(cbq.id);

  // Cancel
  if (data === 'cancel') {
    await clearPending();
    await editMessage(chatId, cbq.message.message_id, 'Cancelled.');
    await audit(chatId, 'cancel', null, 'cancelled');
    return;
  }

  // Confirm tap
  if (data.startsWith('confirm:')) {
    const key     = data.slice(8);
    const pending = await loadPending().catch(() => null);

    if (!pending || pending.actionKey !== key) {
      await editMessage(chatId, cbq.message.message_id, 'Confirmation expired (5 min). Run the command again.');
      await audit(chatId, 'confirm', key, 'expired', false);
      return;
    }

    await clearPending();
    await audit(chatId, 'confirm', key, `confirmed:${pending.action}`);

    if (pending.action === 'post')  return executePost(chatId, cbq.message.message_id, pending.data);
    if (pending.action === 'kill')  return executeKill(chatId, cbq.message.message_id, pending.data);
    if (pending.action === 'run')   return executeRun(chatId, cbq.message.message_id, pending.data);

    await editMessage(chatId, cbq.message.message_id, `✓ ${pending.description || key}`);
    return;
  }

  // Queue item — user tapped "Post N" button
  if (data.startsWith('qi:')) {
    const itemId = data.slice(3);
    const queueData = await internalGet('/api/x-queue').catch(() => ({ items: [] }));
    const item = (queueData.items || []).find(i => i.id === itemId || (i.id || '').startsWith(itemId));

    if (!item) {
      await editMessage(chatId, cbq.message.message_id, 'Post not found — queue may have changed. Run /queue again.');
      return;
    }

    const key = `post-${itemId.slice(0, 40)}`;
    await savePending({ actionKey: key, action: 'post', data: { id: item.id }, description: 'Post to @towerreportai' });
    await tgPost('editMessageText', {
      chat_id: chatId, message_id: cbq.message.message_id,
      text: `Post this to <b>@towerreportai</b>?\n\n${item.text}`.slice(0, 4096),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[
        { text: '✓ Confirm', callback_data: `confirm:${key}` },
        { text: '✗ Cancel',  callback_data: 'cancel' },
      ]] },
    });
    await audit(chatId, 'qi', itemId.slice(0, 40), 'pending_confirm');
    return;
  }

  // Kill story — user tapped "Kill N" button
  if (data.startsWith('ks:')) {
    const idx  = parseInt(data.slice(3));
    const blob = await blobGetJson('tower-ai-stories').catch(() => null);
    const all  = blob ? (Array.isArray(blob) ? blob : (blob.stories || [])) : [];
    const active = all.filter(s => !s.rejected).sort((a, b) => (b.score || 0) - (a.score || 0));
    const story = active[idx];

    if (!story) {
      await editMessage(chatId, cbq.message.message_id, 'Story not found — list may have changed. Run /stories again.');
      return;
    }

    const key = `kill-${Date.now()}`;
    await savePending({ actionKey: key, action: 'kill', data: { headline: story.headline }, description: `Kill "${(story.headline || '').slice(0, 50)}"` });
    await tgPost('editMessageText', {
      chat_id: chatId, message_id: cbq.message.message_id,
      text: `Kill this story?\n\n<b>${story.headline}</b>\n\nIt'll be removed from the pipeline.`.slice(0, 4096),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[
        { text: '✓ Confirm', callback_data: `confirm:${key}` },
        { text: '✗ Cancel',  callback_data: 'cancel' },
      ]] },
    });
    await audit(chatId, 'ks', (story.headline || '').slice(0, 50), 'pending_confirm');
    return;
  }

  await audit(chatId, 'callback', data, 'unhandled', false);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (!header || header !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  let update;
  try { update = typeof req.body === 'object' ? req.body : JSON.parse(req.body); }
  catch { return res.status(400).end(); }

  const chatId = update.message?.chat?.id ?? update.callback_query?.from?.id ?? update.edited_message?.chat?.id ?? null;
  const allowed = Number(process.env.TELEGRAM_CHAT_ID);

  if (chatId !== allowed) {
    if (chatId) console.warn(`[telegram] blocked chat_id=${chatId}`);
    return res.status(200).end();
  }

  const withinLimit = await checkRateLimit();
  if (!withinLimit) {
    await reply(chatId, 'Rate limit hit: 30 commands/hour. Wait until the next hour.');
    await audit(chatId, 'rate_limited', null, 'blocked', false);
    return res.status(200).end();
  }

  try {
    if (update.callback_query)                        await handleCallback(update.callback_query, chatId);
    else if (update.message || update.edited_message) await handleMessage(update.message || update.edited_message, chatId);
  } catch (err) {
    console.error('[telegram] dispatch error:', err.message);
    await reply(chatId, `System error: ${err.message}`).catch(() => {});
  }

  return res.status(200).end();
}
