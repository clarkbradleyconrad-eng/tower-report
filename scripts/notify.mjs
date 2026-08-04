#!/usr/bin/env node
/**
 * Tower Report — notification channel abstraction.
 *
 * Usage:
 *   import { send } from './scripts/notify.mjs';
 *   await send({ title: 'TOWER REPORT — All clear', body: '...', urgency: 'normal' });
 *
 * Channel is selected by the NOTIFY_CHANNEL env var (default: telegram).
 *   telegram — TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (free, instant, default)
 *   slack    — SLACK_OPS_WEBHOOK
 *   sms      — TWILIO_SID + TWILIO_TOKEN + TWILIO_FROM + TWILIO_TO
 *              NOTE: US A2P 10DLC registration is required before SMS will
 *              deliver to US numbers. Register at console.twilio.com before use.
 *
 * SMS hard rule: smsBody is always used for SMS; falls back to title-only.
 * Never pass article body as smsBody — segment limits make it unreadable.
 */

const CHANNEL = process.env.NOTIFY_CHANNEL || 'telegram';

/**
 * @param {{ title: string, body: string, urgency?: 'normal'|'high', smsBody?: string }} opts
 *   title    — short subject line; shown as bold/header on all channels
 *   body     — full message (Telegram + Slack get this); plain text with newlines
 *   urgency  — 'high' adds alert emoji on Slack; no effect on Telegram/SMS
 *   smsBody  — SMS-only condensed payload (headline + X post + link).
 *              If omitted, SMS sends title only.
 */
export async function send({ title, body, urgency = 'normal', smsBody }) {
  switch (CHANNEL) {
    case 'telegram': return sendTelegram(title, body);
    case 'slack':    return sendSlack(title, body, urgency);
    case 'sms':      return sendSms(title, smsBody ?? title);
    default: throw new Error(`Unknown NOTIFY_CHANNEL: "${CHANNEL}". Valid: telegram, slack, sms`);
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(title, body) {
  const token  = requireEnv('TELEGRAM_BOT_TOKEN');
  const chatId = requireEnv('TELEGRAM_CHAT_ID');

  // Telegram HTML: only <b>, <i>, <a>, <code>, <pre> are safe — escape everything else.
  const text = `<b>${esc(title)}</b>\n\n${esc(body)}`;

  // Telegram caps individual messages at 4096 chars; truncate gracefully.
  const payload = text.length > 4096 ? text.slice(0, 4092) + '…' : text;

  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: payload,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: false },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Telegram API error ${res.status}: ${err}`);
  }
  return { channel: 'telegram', ok: true };
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function sendSlack(title, body, urgency) {
  const webhook = requireEnv('SLACK_OPS_WEBHOOK');
  const prefix  = urgency === 'high' ? ':rotating_light: ' : ':memo: ';

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `${prefix}*${title}*`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: title, emoji: true },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: body.slice(0, 3000) },
        },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Slack webhook error ${res.status}: ${err}`);
  }
  return { channel: 'slack', ok: true };
}

// ── SMS (Twilio) ──────────────────────────────────────────────────────────────

async function sendSms(title, body) {
  const sid   = requireEnv('TWILIO_SID');
  const token = requireEnv('TWILIO_TOKEN');
  const from  = requireEnv('TWILIO_FROM');
  const to    = requireEnv('TWILIO_TO');

  // Twilio: 160 chars per segment; stay under 5 segments (800 chars) for readability.
  const text = `${title}\n\n${body}`.slice(0, 800);

  const params = new URLSearchParams({ From: from, To: to, Body: text });
  const auth   = Buffer.from(`${sid}:${token}`).toString('base64');

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Twilio API error ${res.status}: ${err}`);
  }
  return { channel: 'sms', ok: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

/** Escape HTML special chars for Telegram HTML parse mode. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
