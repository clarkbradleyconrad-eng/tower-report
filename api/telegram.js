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
 *   4. Free text and commands map to a fixed allowlist — no eval, no shell
 *   5. Max 30 commands/hour; excess pauses and notifies
 *   6. Every command logged to Supabase tg_audit_log
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN      — BotFather token
 *   TELEGRAM_CHAT_ID        — sole allowed chat ID (number)
 *   TELEGRAM_WEBHOOK_SECRET — must match X-Telegram-Bot-Api-Secret-Token header
 *   SUPABASE_URL            — for audit log
 *   SUPABASE_SERVICE_KEY    — for audit log
 *   BLOB_READ_WRITE_TOKEN   — rate-limit + pending-action state
 *   OPS_KEY                 — passed to internal API calls
 *   XAI_API_KEY             — for /check and NLP routing
 */

import { blobGetJson, blobPutJson } from '../bots/lib/blob.js';

const RATE_LIMIT_MAX  = 30;
const RATE_LIMIT_KEY  = 'tower-tg-ratelimit';
const PENDING_KEY     = 'tower-tg-pending';
const PENDING_TTL_MS  = 5 * 60 * 1000;
const BASE            = 'https://tower-report.vercel.app';

// ── Telegram API ──────────────────────────────────────────────────────────────

async function tgPost(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');
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

async function editMessageText(chatId, messageId, text) {
  return tgPost('editMessageText', {
    chat_id:    chatId,
    message_id: messageId,
    text:       String(text).slice(0, 4096),
    parse_mode: 'HTML',
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
      await blobPutJson(`${RATE_LIMIT_KEY}.json`, RATE_LIMIT_KEY,
        { windowStart: now, count: 1 });
      return true;
    }
    if (count >= RATE_LIMIT_MAX) return false;
    await blobPutJson(`${RATE_LIMIT_KEY}.json`, RATE_LIMIT_KEY,
      { windowStart: start, count: count + 1 });
    return true;
  } catch {
    return true;
  }
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
      headers: {
        apikey:         key,
        Authorization:  `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify({
        chat_id: String(chatId),
        command,
        params:  params  || null,
        outcome: outcome || null,
        ok,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('[telegram] audit log failed:', err.message);
  }
}

// ── Internal API helpers ──────────────────────────────────────────────────────

async function internalGet(path) {
  const opsKey = process.env.OPS_KEY || '';
  const sep    = path.includes('?') ? '&' : '?';
  const res    = await fetch(`${BASE}${path}${opsKey ? `${sep}key=${encodeURIComponent(opsKey)}` : ''}`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

// ── Grok helper ───────────────────────────────────────────────────────────────

async function grokAsk(prompt, { webSearch = false, maxTokens = 400 } = {}) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');

  const body = {
    model: 'grok-4',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: maxTokens,
  };
  if (webSearch) {
    body.tools = [{ type: 'web_search_preview' }];
    body.tool_choice = 'auto';
  }

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
  { cmd: 'status',  words: ['status','health','system','running','pipeline','working','ok'] },
  { cmd: 'stories', words: ['stories','story','articles','article','news','written','published','latest'] },
  { cmd: 'queue',   words: ['queue','posts','tweets','tweet','x post','x posts','scheduled','pending'] },
  { cmd: 'bots',    words: ['bots','bot','last run','ran','pipeline','steps','Scout','Briefing'] },
  { cmd: 'audit',   words: ['audit','log','history','commands','recent','what did','what have'] },
  { cmd: 'subs',    words: ['subs','subscribers','email','readers','list','signups'] },
  { cmd: 'traffic', words: ['traffic','views','visits','analytics','readers','pageviews'] },
];

async function nlpRoute(text) {
  const lower = text.toLowerCase();

  // Fast keyword path — no API call
  for (const { cmd, words } of NLP_KEYWORDS) {
    if (words.some(w => lower.includes(w))) return { cmd, args: '' };
  }

  // /check intent
  if (/check|verify|confirm|true|false|did|is it|recruit|commit|portal/.test(lower)) {
    return { cmd: 'check', args: text };
  }

  // Grok fallback for anything ambiguous
  try {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { cmd: 'help', args: '' };

    const prompt = `You route messages to a Texas Longhorns football news bot.
Commands: status, stories, queue, bots, audit, check, post, kill, help
Message: "${text.slice(0, 200)}"
Reply with JSON only, no explanation: {"cmd":"status","args":""}`;

    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'grok-4', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 40 }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const match = content.match(/\{[^}]+\}/);
    if (match) return JSON.parse(match[0]);
  } catch { /* fall through */ }

  return { cmd: 'help', args: '' };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function timeAgo(isoString) {
  if (!isoString) return 'never';
  const ms = Date.now() - new Date(isoString).getTime();
  const h  = Math.round(ms / 3_600_000);
  if (h < 1)  return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function ctTime(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

// ── Command handlers ──────────────────────────────────────────────────────────

const HANDLERS = {

  start: async (chatId) => {
    await reply(chatId,
      '<b>Tower Report</b> is live.\n\n' +
      'Text me anything or use:\n' +
      '/status — system health\n' +
      '/stories — what\'s in the pipeline\n' +
      '/queue — X posts pending\n' +
      '/bots — last run times\n' +
      '/audit — recent commands\n' +
      '/check [topic] — fact-check anything\n\n' +
      'Or just ask: "what stories do we have?" "is the pipeline running?" etc.'
    );
    return 'started';
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
        msg += `\nRejected for:\n`;
        q.rejectedDetail.slice(0, 3).forEach(r => {
          msg += `  • ${r.headline?.slice(0, 60) || '?'} (${r.reason || '?'})\n`;
        });
      }
    }

    const success = health.lastSuccess || {};
    const stepNames = {
      'stories-refresh':   'Story Scout',
      'briefing':          'Briefing Writer',
      'x-generate':        'X Writer',
      'verify-recruiting': 'Recruiting Verifier',
      'social-post':       'Social Poster',
    };

    const stepLines = Object.entries(success)
      .map(([k, v]) => `  ${stepNames[k] || k}: ${timeAgo(v)}`)
      .join('\n');

    if (stepLines) msg += `\n<b>Steps:</b>\n${stepLines}`;

    if (!health.ok && health.error) msg += `\n\nError: ${health.error}`;

    await reply(chatId, msg);
    return 'ok';
  },

  stories: async (chatId) => {
    const blob    = await blobGetJson('tower-ai-stories');
    const all     = Array.isArray(blob) ? blob : (blob?.stories || []);
    const active  = all.filter(s => !s.rejected).sort((a, b) => (b.score || 0) - (a.score || 0));
    const recent  = all.filter(s => s.rejected).slice(0, 3);

    if (!active.length) {
      await reply(chatId, 'No stories in the pipeline right now. Next pipeline run will pull more.');
      return 'ok';
    }

    let msg = `<b>Stories (${active.length} active)</b>\n\n`;
    active.slice(0, 6).forEach((s, i) => {
      const pub = s.published ? ' ✓' : '';
      msg += `${i + 1}. <b>${s.headline || '?'}</b>${pub}\n`;
      msg += `   Score ${s.score ?? '?'} · ${s.category || 'general'}\n`;
      if (s.hook) msg += `   ${s.hook.slice(0, 80)}…\n`;
      msg += '\n';
    });

    if (recent.length) {
      msg += `<b>Recently rejected:</b>\n`;
      recent.forEach(s => {
        msg += `  • ${(s.headline || '?').slice(0, 60)}\n`;
      });
    }

    await reply(chatId, msg.trim());
    return 'ok';
  },

  queue: async (chatId) => {
    const data    = await internalGet('/api/x-queue');
    const items   = data.items || [];
    const pending = items.filter(i => i.status === 'pending');
    const posted  = items.filter(i => i.status === 'posted').slice(0, 3);

    if (!pending.length && !posted.length) {
      await reply(chatId, 'X queue is empty.\n\nRun /run to generate new posts.');
      return 'ok';
    }

    let msg = '';

    if (pending.length) {
      msg += `<b>Pending (${pending.length})</b>\n\n`;
      pending.slice(0, 5).forEach((item, i) => {
        msg += `${i + 1}. ${(item.text || '?').slice(0, 200)}\n`;
        if (item.link) msg += `   ${item.link}\n`;
        msg += '\n';
      });
    }

    if (posted.length) {
      msg += `<b>Recently posted:</b>\n`;
      posted.forEach(item => {
        msg += `  ✓ ${(item.text || '?').slice(0, 80)}…\n`;
      });
    }

    await reply(chatId, msg.trim());
    return 'ok';
  },

  bots: async (chatId) => {
    const health  = await internalGet('/api/health');
    const success = health.lastSuccess || {};

    const stepNames = {
      'stories-refresh':   'Story Scout',
      'briefing':          'Briefing Writer',
      'x-generate':        'X Writer',
      'verify-recruiting': 'Recruiting Verifier',
      'social-post':       'Social Poster',
    };

    let msg = '<b>Bot Run Times</b>\n\n';

    if (!Object.keys(success).length) {
      msg += 'No run data yet — pipeline hasn\'t completed a full run.';
    } else {
      Object.entries(success).forEach(([k, v]) => {
        const name = stepNames[k] || k;
        msg += `${name}: ${timeAgo(v)}\n`;
        if (v) msg += `  Last: ${ctTime(v)}\n`;
      });
    }

    msg += `\nPipeline last ran: ${timeAgo(health.lastRun)}`;
    if (health.latestRun?.slot) msg += ` (${health.latestRun.slot} run)`;

    await reply(chatId, msg);
    return 'ok';
  },

  audit: async (chatId) => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      await reply(chatId, 'Audit log not configured (missing Supabase env vars).');
      return 'error';
    }

    const r = await fetch(
      `${url}/rest/v1/tg_audit_log?order=ts.desc&limit=15`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) }
    );
    const rows = await r.json();

    if (!Array.isArray(rows) || !rows.length) {
      await reply(chatId, 'No audit log entries yet.');
      return 'ok';
    }

    let msg = '<b>Recent Commands</b>\n\n';
    rows.forEach(row => {
      const mark = row.ok ? '✓' : '✗';
      const ts   = ctTime(row.ts);
      msg += `${mark} <code>${row.command}</code>`;
      if (row.params) msg += ` ${row.params.slice(0, 40)}`;
      msg += ` — ${ts}\n`;
    });

    await reply(chatId, msg.trim());
    return 'ok';
  },

  subs: async (chatId) => {
    await reply(chatId, 'Subscriber count isn\'t wired up yet — Resend analytics aren\'t exposed via API.\n\nFor now check the Resend dashboard at resend.com/audiences.');
    return 'stub';
  },

  traffic: async (chatId) => {
    await reply(chatId, 'Vercel Web Analytics data requires enabling analytics in the Vercel dashboard first.\n\nGo to tower-report.vercel.app → Analytics → Enable, then this will work.');
    return 'stub';
  },

  check: async (chatId, args) => {
    if (!args) {
      await reply(chatId, 'What do you want to check? Example:\n/check did [player] decommit\n/check latest on [name] recruiting');
      return 'ok';
    }

    await reply(chatId, `Checking: <i>${args.slice(0, 100)}</i>…`);

    const prompt = `You are a Texas Longhorns football recruiting and news expert. Answer this question using the most current information available. Be direct and concise (under 150 words). If you're not certain, say so.

Question: ${args}`;

    const answer = await grokAsk(prompt, { webSearch: true, maxTokens: 300 });
    await reply(chatId, answer || 'No answer from Grok.');
    return 'ok';
  },

  // Phase 3 action stubs — will be implemented with confirm-tap gate
  post:    async (chatId) => { await reply(chatId, '⏳ /post — Phase 3 (with confirm tap) coming soon.'); return 'stub'; },
  kill:    async (chatId) => { await reply(chatId, '⏳ /kill — Phase 3 (with confirm tap) coming soon.'); return 'stub'; },
  correct: async (chatId) => { await reply(chatId, '⏳ /correct — Phase 3 coming soon.'); return 'stub'; },
  fix:     async (chatId) => { await reply(chatId, '⏳ /fix — Phase 3 coming soon.'); return 'stub'; },
  verify:  async (chatId) => { await reply(chatId, '⏳ /verify — Phase 3 coming soon.'); return 'stub'; },
  run:     async (chatId) => { await reply(chatId, '⏳ /run — Phase 3 (triggers pipeline with confirm tap) coming soon.'); return 'stub'; },
  pause:   async (chatId) => { await reply(chatId, '⏳ /pause — Phase 3 coming soon.'); return 'stub'; },
  resume:  async (chatId) => { await reply(chatId, '⏳ /resume — Phase 3 coming soon.'); return 'stub'; },
  deploy:  async (chatId) => { await reply(chatId, '⏳ /deploy — Phase 3 (guard-gated) coming soon.'); return 'stub'; },
  idea:    async (chatId) => { await reply(chatId, '⏳ /idea — Phase 3 coming soon.'); return 'stub'; },

  help: async (chatId) => {
    await reply(chatId,
      'Available commands:\n\n' +
      '/status — system health & last pipeline run\n' +
      '/stories — stories in the pipeline\n' +
      '/queue — X posts waiting to be sent\n' +
      '/bots — when each bot last ran\n' +
      '/audit — your recent commands\n' +
      '/check [topic] — fact-check or look up anything\n\n' +
      'Or just text naturally — "what stories do we have?", "is the queue empty?", etc.'
    );
    return 'ok';
  },
};

// ── Message router ────────────────────────────────────────────────────────────

async function handleMessage(message, chatId) {
  const text = (message.text || '').trim();
  if (!text) return;

  // Natural language — route to a command
  if (!text.startsWith('/')) {
    const { cmd, args } = await nlpRoute(text);
    const handler = HANDLERS[cmd] || HANDLERS.help;
    let outcome = 'ok';
    try {
      outcome = (await handler(chatId, args || text)) ?? 'ok';
    } catch (err) {
      await reply(chatId, `Error: ${err.message}`);
      outcome = `error: ${err.message.slice(0, 200)}`;
    }
    await audit(chatId, `nlp→${cmd}`, text.slice(0, 100), outcome, outcome !== 'error');
    return;
  }

  // Parse /command[@bot] args
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd  = rawCmd.slice(1).replace(/@\w+$/, '').toLowerCase();
  const args = rest.join(' ');

  const handler = HANDLERS[cmd];
  if (!handler) {
    const all = ['status','stories','queue','bots','audit','check'].map(c => `/${c}`).join(' ');
    await reply(chatId, `Unknown command: /${cmd}\n\nTry: ${all}\nOr just text me naturally.`);
    await audit(chatId, `/${cmd}`, args || null, 'unknown_command', false);
    return;
  }

  let outcome = 'ok';
  try {
    outcome = (await handler(chatId, args)) ?? 'ok';
  } catch (err) {
    await reply(chatId, `Error in /${cmd}: ${err.message}`);
    outcome = `error: ${String(err.message).slice(0, 200)}`;
    await audit(chatId, `/${cmd}`, args || null, outcome, false);
    return;
  }
  await audit(chatId, `/${cmd}`, args || null, outcome);
}

// ── Callback router ───────────────────────────────────────────────────────────

async function handleCallback(cbq, chatId) {
  const data = cbq.data || '';
  await answerCbq(cbq.id);

  if (data === 'cancel') {
    await clearPending();
    await editMessageText(chatId, cbq.message.message_id, 'Cancelled.');
    await audit(chatId, 'cancel', null, 'cancelled');
    return;
  }

  if (data.startsWith('confirm:')) {
    const key     = data.slice(8);
    const pending = await loadPending().catch(() => null);

    if (!pending || pending.actionKey !== key) {
      await editMessageText(chatId, cbq.message.message_id,
        'Confirmation expired (5 min). Run the command again.');
      await audit(chatId, 'confirm', key, 'expired', false);
      return;
    }

    await clearPending();
    // Phase 3 dispatches real actions here based on pending.action
    await editMessageText(chatId, cbq.message.message_id,
      `✓ <b>${pending.description || key}</b>\n\n⏳ Action execution — Phase 3 coming soon.`);
    await audit(chatId, 'confirm', key, `confirmed:${pending.action || 'stub'}`);
    return;
  }

  await audit(chatId, 'callback', data, 'unhandled', false);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Security gate 1 — secret token
  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (!header || header !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse Telegram update
  let update;
  try {
    update = typeof req.body === 'object' ? req.body : JSON.parse(req.body);
  } catch {
    return res.status(400).end();
  }

  // Security gate 2 — chat allowlist
  const chatId = update.message?.chat?.id
    ?? update.callback_query?.from?.id
    ?? update.edited_message?.chat?.id
    ?? null;

  const allowed = Number(process.env.TELEGRAM_CHAT_ID);
  if (chatId !== allowed) {
    if (chatId) console.warn(`[telegram] blocked chat_id=${chatId}`);
    return res.status(200).end();
  }

  // Security gate 3 — rate limit
  const withinLimit = await checkRateLimit();
  if (!withinLimit) {
    await reply(chatId,
      'Rate limit hit: 30 commands/hour. Wait until the next hour.'
    );
    await audit(chatId, 'rate_limited', null, 'blocked', false);
    return res.status(200).end();
  }

  // Dispatch
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query, chatId);
    } else if (update.message || update.edited_message) {
      await handleMessage(update.message || update.edited_message, chatId);
    }
  } catch (err) {
    console.error('[telegram] dispatch error:', err.message);
    await reply(chatId, `System error: ${err.message}`).catch(() => {});
  }

  return res.status(200).end();
}
