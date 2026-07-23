/**
 * Tower Report — /api/x-settings
 *
 * GET /api/x-settings  — return current settings
 * PUT /api/x-settings  — replace settings (body: partial settings object)
 *
 * Default settings shape:
 *   mode: 'manual' | 'trusted' | 'auto'
 *   paused: boolean
 *   maxPostsPerDay: number  (default 5)
 *   minIntervalMinutes: number  (default 90)
 *   linkRatioPct: number  (default 30)  — % of posts that include a Tower Report link
 *   categories: string[]  — enabled: breaking, analysis, recruiting, quote, stat, gameday, promo, question
 *   trustedSources: string[]  — auto-approve posts citing these sources in trusted mode
 *   blacklistTopics: string[]  — never post about these topics
 *   blacklistSources: string[]  — never cite these sources
 *
 * Auth: OPS_KEY
 */

import { blobGetJson, blobPutJson } from '../bots/lib/blob.js';

const SETTINGS_PATH   = 'tower-x-settings.json';
const SETTINGS_PREFIX = 'tower-x-settings';

const DEFAULTS = {
  mode:               'manual',
  paused:             false,
  maxPostsPerDay:     5,
  minIntervalMinutes: 90,
  linkRatioPct:       30,
  categories:         ['breaking', 'analysis', 'recruiting', 'quote', 'stat', 'gameday', 'promo', 'question'],
  trustedSources:     ['CJ Vogel', 'Inside Texas', '247Sports', 'On3', 'Rivals', 'ESPN', 'The Athletic'],
  blacklistTopics:    [],
  blacklistSources:   [],
};

function authOk(req) {
  const key = process.env.OPS_KEY;
  if (!key) return true;
  const h = req.headers['x-ops-key'] || '';
  const p = new URL(req.url, 'http://localhost').searchParams.get('key') || '';
  return h === key || p === key;
}

async function readSettings() {
  const stored = await blobGetJson(SETTINGS_PREFIX);
  return { ...DEFAULTS, ...(stored || {}) };
}

export default async function handler(req, res) {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    const settings = await readSettings();
    return res.status(200).json({ ok: true, settings });
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    let body;
    try { body = typeof req.body === 'object' ? req.body : JSON.parse(req.body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    const current = await readSettings();
    const allowed = Object.keys(DEFAULTS);
    const next    = { ...current };

    for (const k of allowed) {
      if (k in body) next[k] = body[k];
    }
    next.updatedAt = new Date().toISOString();

    await blobPutJson(SETTINGS_PATH, SETTINGS_PREFIX, next);
    return res.status(200).json({ ok: true, settings: next });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
