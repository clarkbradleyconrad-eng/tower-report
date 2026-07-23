/**
 * Tower Report — /api/social-post
 *
 * Automatically posts to @towerreportai on X after each pipeline run.
 * Posts two tweets per pipeline cycle:
 *   1. The "breaking" draft from social-drafter for the top story
 *   2. A headline tweet for the top briefing item
 *
 * Dedup: nothing gets posted twice within 8 hours (keyed by story/brief ID).
 * History is kept in Vercel Blob (tower-social-posted.json), capped at 200.
 *
 * Env vars required:
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob
 *   CRON_SECRET           — (optional) auth
 *
 * Modes:
 *   GET /api/social-post            — live run, posts to X
 *   GET /api/social-post?dryRun=1   — full logic, no actual tweet sent
 */

import { xCreds, credsOk, postTweet } from '../bots/lib/xapi.js';
import { blobGetJson, blobPutJson, KEYS } from '../bots/lib/blob.js';

const POSTED_PATH   = 'tower-social-posted.json';
const POSTED_PREFIX = 'tower-social-posted';
const DEDUP_WINDOW_MS = 8 * 60 * 60 * 1000; // 8 h — one cycle gap
const MAX_HISTORY = 200;

function tweetUrl(id) {
  return `https://x.com/towerreportai/status/${id}`;
}

/** Trim a string to fit within the 280-char X limit. */
function cap(s, max = 280) {
  s = String(s || '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const tok  = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    if (auth !== `Bearer ${secret}` && tok !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const dryRun = new URL(req.url, 'http://localhost').searchParams.get('dryRun') === '1';

  const creds = xCreds();
  if (!credsOk(creds)) {
    return res.status(503).json({
      error: 'X API credentials not configured',
      missing: ['X_API_KEY','X_API_SECRET','X_ACCESS_TOKEN','X_ACCESS_TOKEN_SECRET'].filter(k => !process.env[k]),
    });
  }

  // Load posted history for dedup
  const history = (await blobGetJson(POSTED_PREFIX)) || [];
  const cutoff  = Date.now() - DEDUP_WINDOW_MS;
  const recentIds = new Set(
    history
      .filter(p => new Date(p.postedAt || 0).getTime() >= cutoff)
      .map(p => p.id)
  );

  const posted  = [];
  const skipped = [];

  /* ── 1. Top story — use the "breaking" draft from social-drafter ── */
  const draftsBlob = await blobGetJson(KEYS.social.prefix);
  const drafts     = draftsBlob?.drafts || [];
  const storyHed   = draftsBlob?.storyHeadline || null;
  // Use a stable ID: slug of the story headline
  const storyId = storyHed
    ? 'story-' + storyHed.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)
    : null;

  if (storyId && drafts.length) {
    if (recentIds.has(storyId)) {
      skipped.push({ id: storyId, reason: 'already posted within 8h' });
    } else {
      const draft = drafts.find(d => d.style === 'breaking') || drafts[0];
      if (draft?.text) {
        const text = cap(draft.text);
        try {
          let tweetId = null;
          if (!dryRun) {
            const resp = await postTweet(text, creds);
            tweetId = resp?.data?.id || null;
          }
          const entry = {
            id: storyId, type: 'story', text,
            tweetId, url: tweetId ? tweetUrl(tweetId) : null,
            headline: storyHed,
            postedAt: new Date().toISOString(), dryRun,
          };
          posted.push(entry);
          console.log(`[social-post] story tweet ${dryRun ? '(dry)' : 'LIVE'}: ${entry.url || text.slice(0, 80)}`);
        } catch (err) {
          console.error('[social-post] story tweet failed:', err.message);
          skipped.push({ id: storyId, reason: err.message });
        }
      }
    }
  } else {
    skipped.push({ id: 'story', reason: storyId ? 'no drafts from social-drafter yet' : 'social-drafter has not run yet' });
  }

  /* ── 2. Top briefing item ── */
  const briefBlob  = await blobGetJson('tower-briefing');
  const briefItems = Array.isArray(briefBlob?.briefing) ? briefBlob.briefing : [];
  const topBrief   = briefItems.find(b => b.headline || b.text);

  if (topBrief) {
    const briefId = topBrief.id ||
      'brief-' + (topBrief.headline || topBrief.text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);

    if (recentIds.has(briefId)) {
      skipped.push({ id: briefId, reason: 'already posted within 8h' });
    } else {
      const hed      = topBrief.headline || topBrief.text || '';
      const context  = topBrief.context ? ` — ${topBrief.context}` : '';
      const raw      = `🤘 Texas football: ${hed}${context} #HookEm`;
      const text     = cap(raw);
      try {
        let tweetId = null;
        if (!dryRun) {
          const resp = await postTweet(text, creds);
          tweetId = resp?.data?.id || null;
        }
        const entry = {
          id: briefId, type: 'briefing', text,
          tweetId, url: tweetId ? tweetUrl(tweetId) : null,
          headline: hed,
          postedAt: new Date().toISOString(), dryRun,
        };
        posted.push(entry);
        console.log(`[social-post] briefing tweet ${dryRun ? '(dry)' : 'LIVE'}: ${entry.url || text.slice(0, 80)}`);
      } catch (err) {
        console.error('[social-post] briefing tweet failed:', err.message);
        skipped.push({ id: briefId, reason: err.message });
      }
    }
  } else {
    skipped.push({ id: 'briefing', reason: 'no briefing items available' });
  }

  /* ── Persist history ── */
  if (!dryRun && posted.length) {
    const next = [...posted, ...history].slice(0, MAX_HISTORY);
    try {
      await blobPutJson(POSTED_PATH, POSTED_PREFIX, next);
    } catch (err) {
      console.warn('[social-post] history write failed:', err.message);
    }
  }

  return res.status(200).json({
    ok: true,
    dryRun,
    posted: posted.length,
    skipped: skipped.length,
    results: posted,
    skippedDetail: skipped,
  });
}
