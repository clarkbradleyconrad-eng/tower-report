/**
 * Tower Report — /api/health
 *
 * Pipeline observability. Returns the last refresh run and the last
 * successful run time per step, read from the tower-refresh-log.json
 * heartbeat blob written by /api/orchestrator.
 *
 * Env vars:
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token
 */

export const config = { runtime: 'edge' };

const BLOB_API = 'https://blob.vercel-storage.com';
const LOG_PREFIX = 'tower-refresh-log'; // prefix without .json — REST API appends a hash

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=60' },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return json({ ok: false, error: 'Storage not configured' }, 503);

  try {
    // no-store: edge fetch caching would pin this fixed list URL to an old blob
    const listRes = await fetch(`${BLOB_API}?prefix=${encodeURIComponent(LOG_PREFIX)}&limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!listRes.ok) throw new Error(`Blob list ${listRes.status}`);
    const { blobs = [] } = await listRes.json();
    if (!blobs.length) {
      return json({ ok: false, lastRun: null, lastSuccess: {}, note: 'No refresh run recorded yet' });
    }
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const dataRes = await fetch(blobs[0].downloadUrl || blobs[0].url);
    if (!dataRes.ok) throw new Error(`Blob fetch ${dataRes.status}`);
    const log = await dataRes.json();

    const lastRunMs = log.lastRun ? new Date(log.lastRun).getTime() : 0;
    const hoursSinceLastRun = lastRunMs ? +((Date.now() - lastRunMs) / 3600000).toFixed(1) : null;

    const lastSuccess = { ...(log.lastSuccess || {}) };
    delete lastSuccess['tiktok-drafts']; // step removed from the pipeline 2026-07-09

    // Editorial-quality summary from the latest run: dedup drops and
    // accuracy-gate rejections, surfaced directly instead of buried in steps
    const latestRun = (log.runs || [])[0] || null;
    const refreshStep = latestRun?.steps?.find(s => s.name === 'stories-refresh');
    const quality = refreshStep?.detail ? {
      storiesAdded: refreshStep.detail.added ?? null,
      duplicatesDropped: refreshStep.detail.droppedDuplicates ?? null,
      storiesRejected: refreshStep.detail.rejected ?? null,
      rejectedDetail: refreshStep.detail.rejectedDetail || [],
    } : null;

    return json({
      ok: true,
      lastRun: log.lastRun || null,
      hoursSinceLastRun,
      lastSuccess,
      quality,
      latestRun,
    });
  } catch (err) {
    console.error('[tower/health]', err.message);
    return json({ ok: false, error: err.message }, 500);
  }
}
