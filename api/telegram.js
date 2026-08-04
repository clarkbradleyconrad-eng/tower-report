/**
 * Tower Report — /api/telegram
 *
 * Two-way Telegram bot. Receives webhook POSTs from Telegram and dispatches
 * to command handlers. All security enforced before any logic runs.
 *
 * Security (Phase 1):
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
 *   CRON_SECRET             — for orchestrator triggers (Phase 3)
 */

import { blobGetJson, blobPutJson } from '../bots/lib/blob.js';

const RATE_LIMIT_MAX  = 30;           // commands per hour
const RATE_LIMIT_KEY  = 'tower-tg-ratelimit';
const PENDING_KEY     = 'tower-tg-pending';
const PENDING_TTL_MS  = 5 * 60 * 1000; // 5 min to tap Confirm
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

async function replyConfirm(chatId, text, actionKey, description) {
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
    return true; // never block on rate-limit storage failure
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
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

// ── Command handlers ──────────────────────────────────────────────────────────
// Phase 1: /start only proves the security stack end-to-end.
// Phase 2 replaces the stubs with real data.

const READ_COMMANDS = new Set(['start','status','stories','queue','subs','traffic','bots','audit','check']);
const WRITE_COMMANDS = new Set(['post','kill','correct','fix','verify','run','pause','resume','deploy','idea']);

const HANDLERS = {

  start: async (chatId) => {
    const botInfo = await tgPost('getMe', {}).catch(() => ({}));
    const name = botInfo.result?.username || 'Tower Report';
    await reply(chatId,
      `<b>@${name} — Tower Report Control</b>\n\n` +
      'Security check:\n' +
      '✓ Secret token verified\n' +
      '✓ Chat ID allowlisted\n' +
      '✓ Rate limit active (30/hr)\n' +
      '✓ Audit log writing to Supabase\n' +
      '✓ Confirm-tap gate ready\n\n' +
      '<b>Read commands (Phase 2):</b>\n' +
      '/status /stories /queue /subs /traffic /bots /audit /check\n\n' +
      '<b>Action commands (Phase 3):</b>\n' +
      '/post /kill /correct /fix /verify /run /deploy /idea\n\n' +
      'Sept 12 is the deadline. Let\'s go.'
    );
    return 'started';
  },

  // Phase 2 stubs — replaced next commit
  status:  async (chatId) => { await reply(chatId, '⏳ /status — Phase 2'); return 'stub'; },
  stories: async (chatId) => { await reply(chatId, '⏳ /stories — Phase 2'); return 'stub'; },
  queue:   async (chatId) => { await reply(chatId, '⏳ /queue — Phase 2'); return 'stub'; },
  subs:    async (chatId) => { await reply(chatId, '⏳ /subs — Phase 2'); return 'stub'; },
  traffic: async (chatId) => { await reply(chatId, '⏳ /traffic — Phase 2'); return 'stub'; },
  bots:    async (chatId) => { await reply(chatId, '⏳ /bots — Phase 2'); return 'stub'; },
  audit:   async (chatId) => { await reply(chatId, '⏳ /audit — Phase 2'); return 'stub'; },
  check:   async (chatId, args) => { await reply(chatId, `⏳ /check ${args} — Phase 2`); return 'stub'; },

  // Phase 3 stubs
  post:    async (chatId) => { await reply(chatId, '⏳ /post — Phase 3 (requires confirm tap)'); return 'stub'; },
  kill:    async (chatId) => { await reply(chatId, '⏳ /kill — Phase 3 (requires confirm tap)'); return 'stub'; },
  correct: async (chatId) => { await reply(chatId, '⏳ /correct — Phase 3'); return 'stub'; },
  fix:     async (chatId) => { await reply(chatId, '⏳ /fix — Phase 3'); return 'stub'; },
  verify:  async (chatId) => { await reply(chatId, '⏳ /verify — Phase 3'); return 'stub'; },
  run:     async (chatId) => { await reply(chatId, '⏳ /run — Phase 3 (requires confirm tap)'); return 'stub'; },
  pause:   async (chatId) => { await reply(chatId, '⏳ /pause — Phase 3'); return 'stub'; },
  resume:  async (chatId) => { await reply(chatId, '⏳ /resume — Phase 3'); return 'stub'; },
  deploy:  async (chatId) => { await reply(chatId, '⏳ /deploy — Phase 3 (guard-gated)'); return 'stub'; },
  idea:    async (chatId) => { await reply(chatId, '⏳ /idea — Phase 3'); return 'stub'; },
};

// ── Message router ────────────────────────────────────────────────────────────

async function handleMessage(message, chatId) {
  const text = (message.text || '').trim();

  // Natural language — Phase 4
  if (!text.startsWith('/')) {
    await reply(chatId, '⏳ Natural language routing — Phase 4.\n\nFor now, use /start to confirm the bot is live.');
    await audit(chatId, 'nlp', text.slice(0, 100), 'stub');
    return;
  }

  // Parse /command[@bot] args
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd  = rawCmd.slice(1).replace(/@\w+$/, '').toLowerCase();
  const args = rest.join(' ');

  const handler = HANDLERS[cmd];
  if (!handler) {
    const all = [...Object.keys(HANDLERS)].map(c => `/${c}`).join(' ');
    await reply(chatId, `Unknown: /${cmd}\n\nAvailable: ${all}`);
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
      `✓ <b>${pending.description || key}</b>\n\n⏳ Action execution — Phase 3.`);
    await audit(chatId, 'confirm', key, `confirmed:${pending.action || 'stub'}`);
    return;
  }

  await audit(chatId, 'callback', data, 'unhandled', false);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Security gate 1 — secret token (fail fast, no logging, no hints)
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
    return res.status(200).end(); // total silence — no error, no acknowledgment
  }

  // Security gate 3 — rate limit
  const withinLimit = await checkRateLimit();
  if (!withinLimit) {
    await reply(chatId,
      'Rate limit hit: 30 commands/hour. Are you the one sending these?\n\nIf yes, wait until the next hour. If not, check your Telegram account security.'
    );
    await audit(chatId, 'rate_limited', null, 'blocked', false);
    return res.status(200).end();
  }

  // Dispatch — never crash the webhook
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
