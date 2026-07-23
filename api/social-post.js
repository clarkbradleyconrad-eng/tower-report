/**
 * Tower Report — /api/social-post
 *
 * Posts to @towerreportai on X. Integrates with the queue system.
 *
 * Behavior by mode (from /api/x-settings):
 *   manual   — only posts items manually approved in the queue (status=approved)
 *   trusted  — auto-posts queue items whose sources[] include a trusted source, else manual
 *   auto     — posts the top N pending/approved queue items up to daily limit
 *
 * Fallback (no queue items): posts the breaking draft from social-drafter
 * and the top briefing item (original behavior, unchanged).
 *
 * Dedup: 8-hour window keyed by tweetId for queue items, by story/brief slug for legacy items.
 * History: tower-social-posted.json, capped at 200.
 *
 * GET /api/social-post            — live run
 * GET /api/social-post?dryRun=1   — full logic, no tweet sent
 *
 * Auth: CRON_SECRET (Bearer or ?token=)
 * Env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, BLOB_READ_WRITE_TOKEN
 */

import { xCreds, credsOk, postTweet } from '../bots/lib/xapi.js';
import { blobGetJson, blobPutJson, KEYS } from '../bots/lib/blob.js';

const POSTED_PATH   = 'tower-social-posted.json';
const POSTED_PREFIX = 'tower-social-posted';
const DEDUP_WINDOW_MS = 8 * 60 * 60 * 1000;
const MAX_HISTORY   = 200;
const BASE_URL      = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';

function tweetUrl(id) { return `https://x.com/towerreportai/status/${id}`; }
function cap(s, max = 280) { s = String(s || ''); return s.length <= max ? s : s.slice(0, max - 1) + '…'; }

function authOk(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers['authorization'] || '';
  const tok  = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
  return auth === `Bearer ${secret}` || tok === secret;
}

async function fetchSettings() {
  try {
    const r = await fetch(`${BASE_URL}/api/x-settings`);
    const j = await r.json();
    return j.settings || {};
  } catch {
    return { mode: 'manual', paused: false, maxPostsPerDay: 5, minIntervalMinutes: 90, trustedSources: [] };
  }
}

async function fetchQueue(status) {
  try {
    const r = await fetch(`${BASE_URL}/api/x-queue?status=${status}`);
    const j = await r.json();
    return j.items || [];
  } catch { return []; }
}

async function markPosted(itemId, tweetId, tweetUrl) {
  try {
    await fetch(`${BASE_URL}/api/x-queue`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-ops-key': process.env.OPS_KEY || '' },
      body: JSON.stringify({ id: itemId, status: 'posted', tweetId, tweetUrl, postedAt: new Date().toISOString() }),
    });
  } catch { /* best effort */ }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });

  const dryRun = new URL(req.url, 'http://localhost').searchParams.get('dryRun') === '1';

  const creds = xCreds();
  if (!credsOk(creds)) {
    return res.status(503).json({
      error: 'X API credentials not configured',
      missing: ['X_API_KEY','X_API_SECRET','X_ACCESS_TOKEN','X_ACCESS_TOKEN_SECRET'].filter(k => !process.env[k]),
    });
  }

  const [settings, history] = await Promise.all([
    fetchSettings(),
    blobGetJson(POSTED_PREFIX).then(h => h || []),
  ]);

  if (settings.paused) {
    return res.status(200).json({ ok: true, paused: true, posted: 0, skipped: 0, message: 'Posting is paused' });
  }

  const cutoff    = Date.now() - DEDUP_WINDOW_MS;
  const recentIds = new Set(
    history
      .filter(p => new Date(p.postedAt || 0).getTime() >= cutoff)
      .map(p => p.id)
  );

  // Count how many real posts were made today
  const todayStart  = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const postedToday = history.filter(p => new Date(p.postedAt || 0) >= todayStart && !p.dryRun).length;
  const remaining   = Math.max(0, (settings.maxPostsPerDay || 5) - postedToday);

  const posted  = [];
  const skipped = [];

  async function doPost(item) {
    const text = cap(item.text);
    if (!dryRun) {
      const resp    = await postTweet(text, creds);
      const tweetId = resp?.data?.id || null;
      const url     = tweetId ? tweetUrl(tweetId) : null;
      return { tweetId, url };
    }
    return { tweetId: null, url: null };
  }

  /* ── Queue-based posting ── */
  const mode = settings.mode || 'manual';

  if (mode === 'manual' || mode === 'trusted' || mode === 'auto') {
    // approved items: always eligible
    const approved = await fetchQueue('approved');

    // in trusted/auto mode: also consider pending items from trusted sources
    let candidates = [...approved];
    if (mode === 'trusted' || mode === 'auto') {
      const pending  = await fetchQueue('pending');
      const trusted  = (settings.trustedSources || []).map(s => s.toLowerCase());
      const autoPass = pending.filter(item =>
        (item.sources || []).some(s => trusted.some(t => s.toLowerCase().includes(t)))
      );
      candidates = [...approved, ...autoPass];
    }
    if (mode === 'auto') {
      const pending = await fetchQueue('pending');
      // In auto mode all pending items are eligible
      candidates = [...new Map([...approved, ...pending].map(i => [i.id, i])).values()];
    }

    // Sort by priority then creation time
    candidates.sort((a, b) => (a.priority || 99) - (b.priority || 99) || new Date(a.createdAt) - new Date(b.createdAt));

    const toPost = candidates
      .filter(item => !recentIds.has(item.id))
      .slice(0, remaining);

    for (const item of toPost) {
      try {
        const { tweetId, url } = await doPost(item);
        const entry = {
          id: item.id, type: 'queue', format: item.format, text: item.text,
          tweetId, url, headline: item.text.slice(0, 80),
          postedAt: new Date().toISOString(), dryRun,
        };
        posted.push(entry);
        if (!dryRun && tweetId) await markPosted(item.id, tweetId, url);
        console.log(`[social-post] queue tweet ${dryRun ? '(dry)' : 'LIVE'}: ${url || item.text.slice(0, 80)}`);
      } catch (err) {
        console.error('[social-post] queue tweet failed:', err.message);
        skipped.push({ id: item.id, reason: err.message });
      }
    }
  }

  /* ── Legacy fallback: social-drafter draft + briefing item ── */
  if (posted.length === 0 && remaining > 0) {
    const draftsBlob = await blobGetJson(KEYS.social.prefix);
    const drafts     = draftsBlob?.drafts || [];
    const storyHed   = draftsBlob?.storyHeadline || null;
    const storyId    = storyHed
      ? 'story-' + storyHed.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)
      : null;

    if (storyId && drafts.length) {
      if (recentIds.has(storyId)) {
        skipped.push({ id: storyId, reason: 'already posted within 8h' });
      } else {
        const draft = drafts.find(d => d.style === 'breaking') || drafts[0];
        if (draft?.text) {
          try {
            const text           = cap(draft.text);
            const { tweetId, url } = await doPost({ text });
            const entry = { id: storyId, type: 'story', text, tweetId, url, headline: storyHed, postedAt: new Date().toISOString(), dryRun };
            posted.push(entry);
            console.log(`[social-post] story tweet ${dryRun ? '(dry)' : 'LIVE'}: ${url || text.slice(0, 80)}`);
          } catch (err) {
            console.error('[social-post] story tweet failed:', err.message);
            skipped.push({ id: storyId, reason: err.message });
          }
        }
      }
    }

    if (remaining - posted.length > 0) {
      const briefBlob  = await blobGetJson('tower-briefing');
      const briefItems = Array.isArray(briefBlob?.briefing) ? briefBlob.briefing : [];
      const topBrief   = briefItems.find(b => b.headline || b.text);
      if (topBrief) {
        const briefId = topBrief.id ||
          'brief-' + (topBrief.headline || topBrief.text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
        if (recentIds.has(briefId)) {
          skipped.push({ id: briefId, reason: 'already posted within 8h' });
        } else {
          const hed     = topBrief.headline || topBrief.text || '';
          const context = topBrief.context ? ` — ${topBrief.context}` : '';
          const text    = cap(`🤘 Texas football: ${hed}${context} #HookEm`);
          try {
            const { tweetId, url } = await doPost({ text });
            const entry = { id: briefId, type: 'briefing', text, tweetId, url, headline: hed, postedAt: new Date().toISOString(), dryRun };
            posted.push(entry);
            console.log(`[social-post] briefing tweet ${dryRun ? '(dry)' : 'LIVE'}: ${url || text.slice(0, 80)}`);
          } catch (err) {
            console.error('[social-post] briefing tweet failed:', err.message);
            skipped.push({ id: briefId, reason: err.message });
          }
        }
      }
    }
  }

  /* ── Persist history ── */
  if (!dryRun && posted.length) {
    const next = [...posted, ...history].slice(0, MAX_HISTORY);
    try { await blobPutJson(POSTED_PATH, POSTED_PREFIX, next); }
    catch (err) { console.warn('[social-post] history write failed:', err.message); }
  }

  return res.status(200).json({
    ok: true, dryRun,
    mode, postedToday: postedToday + posted.filter(p => !p.dryRun).length,
    posted: posted.length, skipped: skipped.length,
    results: posted, skippedDetail: skipped,
  });
}
