/**
 * Tower Report — /api/x-analytics
 *
 * GET  /api/x-analytics          — return summary analytics
 * POST /api/x-analytics/sync     — sync metrics from X API for recent tweet IDs
 *
 * Analytics blob schema:
 *   posts: [{ tweetId, tweetUrl, text, format, postedAt, impressions, likes, retweets, replies, clicks, engagementRate }]
 *   summary: { totalPosts, totalImpressions, avgEngagementRate, topFormats, bestHours, topPosts }
 *   lastSyncAt: ISO string
 *
 * Auth: OPS_KEY
 * Env: X_BEARER_TOKEN (for v2 metrics — requires Basic tier or higher on X API)
 */

import { blobGetJson, blobPutJson } from '../bots/lib/blob.js';

const ANALYTICS_PATH   = 'tower-x-analytics.json';
const ANALYTICS_PREFIX = 'tower-x-analytics';
const POSTED_PREFIX    = 'tower-social-posted';

function authOk(req) {
  const key = process.env.OPS_KEY;
  if (!key) return true;
  const h = req.headers['x-ops-key'] || '';
  const p = new URL(req.url, 'http://localhost').searchParams.get('key') || '';
  return h === key || p === key;
}

function computeSummary(posts) {
  if (!posts.length) return { totalPosts: 0, totalImpressions: 0, avgEngagementRate: 0, topFormats: {}, bestHours: {}, topPosts: [] };

  const totalImpressions = posts.reduce((s, p) => s + (p.impressions || 0), 0);
  const withEng = posts.filter(p => p.impressions > 0);
  const avgEngagementRate = withEng.length
    ? withEng.reduce((s, p) => s + (p.engagementRate || 0), 0) / withEng.length
    : 0;

  const topFormats = {};
  for (const p of posts) {
    if (!p.format) continue;
    if (!topFormats[p.format]) topFormats[p.format] = { posts: 0, impressions: 0, clicks: 0 };
    topFormats[p.format].posts++;
    topFormats[p.format].impressions += (p.impressions || 0);
    topFormats[p.format].clicks      += (p.clicks || 0);
  }

  const bestHours = {};
  for (const p of posts) {
    if (!p.postedAt) continue;
    const h = new Date(p.postedAt).getUTCHours();
    if (!bestHours[h]) bestHours[h] = { posts: 0, impressions: 0 };
    bestHours[h].posts++;
    bestHours[h].impressions += (p.impressions || 0);
  }

  const topPosts = [...posts]
    .filter(p => p.impressions > 0)
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, 10)
    .map(p => ({ tweetId: p.tweetId, tweetUrl: p.tweetUrl, text: p.text, format: p.format, postedAt: p.postedAt, impressions: p.impressions, engagementRate: p.engagementRate }));

  return { totalPosts: posts.length, totalImpressions, avgEngagementRate: Math.round(avgEngagementRate * 100) / 100, topFormats, bestHours, topPosts };
}

export default async function handler(req, res) {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });

  const url = new URL(req.url, 'http://localhost');
  const isSync = url.pathname.endsWith('/sync');

  if (req.method === 'GET' && !isSync) {
    const analytics = await blobGetJson(ANALYTICS_PREFIX);
    if (!analytics) {
      // Build initial analytics from posted history
      const posted = (await blobGetJson(POSTED_PREFIX)) || [];
      const posts = posted
        .filter(p => p.tweetId && !p.dryRun)
        .map(p => ({
          tweetId:         p.tweetId,
          tweetUrl:        p.tweetUrl || null,
          text:            p.text,
          format:          p.type === 'story' ? 'breaking' : 'analysis',
          postedAt:        p.postedAt,
          impressions:     0,
          likes:           0,
          retweets:        0,
          replies:         0,
          clicks:          0,
          engagementRate:  0,
        }));
      const summary = computeSummary(posts);
      return res.status(200).json({ ok: true, analytics: { posts, summary, lastSyncAt: null } });
    }
    return res.status(200).json({ ok: true, analytics });
  }

  if (req.method === 'POST') {
    const bearer = process.env.X_BEARER_TOKEN;
    if (!bearer) {
      return res.status(503).json({ error: 'X_BEARER_TOKEN not configured. Impression metrics require X API Basic tier or higher.' });
    }

    const analytics = (await blobGetJson(ANALYTICS_PREFIX)) || { posts: [], summary: {}, lastSyncAt: null };
    const posted    = (await blobGetJson(POSTED_PREFIX)) || [];

    // Add any new posted tweets not yet tracked
    const tracked = new Set(analytics.posts.map(p => p.tweetId));
    for (const p of posted) {
      if (p.tweetId && !p.dryRun && !tracked.has(p.tweetId)) {
        analytics.posts.push({
          tweetId:        p.tweetId,
          tweetUrl:       p.tweetUrl || null,
          text:           p.text,
          format:         p.type === 'story' ? 'breaking' : 'analysis',
          postedAt:       p.postedAt,
          impressions:    0,
          likes:          0,
          retweets:       0,
          replies:        0,
          clicks:         0,
          engagementRate: 0,
        });
        tracked.add(p.tweetId);
      }
    }

    // Sync the 20 most recent tweets that have tweetIds
    const toSync = analytics.posts
      .filter(p => p.tweetId)
      .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt))
      .slice(0, 20);

    let synced = 0;
    for (const p of toSync) {
      try {
        const metricsUrl = `https://api.twitter.com/2/tweets/${p.tweetId}?tweet.fields=public_metrics,non_public_metrics`;
        const r = await fetch(metricsUrl, {
          headers: { Authorization: `Bearer ${bearer}` },
        });
        if (!r.ok) continue;
        const data = await r.json();
        const pm   = data?.data?.public_metrics || {};
        const npm  = data?.data?.non_public_metrics || {};
        p.impressions    = pm.impression_count    || npm.impression_count    || 0;
        p.likes          = pm.like_count          || 0;
        p.retweets       = pm.retweet_count       || 0;
        p.replies        = pm.reply_count         || 0;
        p.clicks         = npm.url_link_clicks    || 0;
        p.engagementRate = p.impressions > 0
          ? Math.round(((p.likes + p.retweets + p.replies) / p.impressions) * 10000) / 100
          : 0;
        synced++;
      } catch { /* skip on error */ }
    }

    analytics.summary    = computeSummary(analytics.posts);
    analytics.lastSyncAt = new Date().toISOString();

    await blobPutJson(ANALYTICS_PATH, ANALYTICS_PREFIX, analytics);
    return res.status(200).json({ ok: true, synced, totalTracked: analytics.posts.length, summary: analytics.summary });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
