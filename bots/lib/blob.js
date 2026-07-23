/**
 * Tower Report bots — shared Vercel Blob JSON helpers
 *
 * Same REST pattern used across the api/ endpoints: list by prefix (the
 * API appends a random hash to pathnames, so exact-name lookups never
 * match), newest blob wins on read, delete-then-put on write.
 */

const BLOB_API = 'https://blob.vercel-storage.com';

function token() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

async function list(prefix) {
  const t = token();
  if (!t) return [];
  const res = await fetch(`${BLOB_API}?prefix=${encodeURIComponent(prefix)}&limit=50`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) return [];
  return (await res.json()).blobs || [];
}

/** Read the newest JSON blob whose pathname starts with prefix (no .json). */
export async function blobGetJson(prefix) {
  try {
    const blobs = await list(prefix);
    if (!blobs.length) return null;
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const res = await fetch(blobs[0].downloadUrl || blobs[0].url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Replace all blobs under prefix with a single fresh one at pathname. */
export async function blobPutJson(pathname, prefix, data) {
  const t = token();
  if (!t) throw new Error('BLOB_READ_WRITE_TOKEN not configured');
  const existing = await list(prefix);
  if (existing.length) {
    await fetch(BLOB_API, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: existing.map(b => b.url) }),
    });
  }
  const res = await fetch(`${BLOB_API}/${pathname}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Blob write failed: ${await res.text().catch(() => res.status)}`);
  }
}

/** Read-modify-write. fn receives current value (or fallback) and returns the new value. */
export async function blobUpdateJson(pathname, prefix, fn, fallback = null) {
  const current = (await blobGetJson(prefix)) ?? fallback;
  const next = await fn(current);
  await blobPutJson(pathname, prefix, next);
  return next;
}

/* Blob keys used by the bot system (prefix = pathname without .json) */
export const KEYS = {
  runs: { path: 'tower-bot-runs.json', prefix: 'tower-bot-runs' },
  stats: { path: 'tower-bot-stats.json', prefix: 'tower-bot-stats' },
  rejected: { path: 'tower-bot-rejected.json', prefix: 'tower-bot-rejected' },
  overrides: { path: 'tower-bot-overrides.json', prefix: 'tower-bot-overrides' },
  social: { path: 'tower-social-drafts.json', prefix: 'tower-social-drafts' },
  heartbeat: { path: 'tower-refresh-log.json', prefix: 'tower-refresh-log' },
  stories: { path: 'tower-ai-stories.json', prefix: 'tower-ai-stories' },
  recruitingBoard: { path: 'tower-recruiting-board.json', prefix: 'tower-recruiting-board' },
  socialPosted: { path: 'tower-social-posted.json', prefix: 'tower-social-posted' },
};

/**
 * Append a rejected output to the per-bot rejection queue (capped 50 each).
 * Shape: { <botId>: [{ ts, promptHash, score, reasons, output }] }
 * This is the blob equivalent of /data/rejected/{botId}.json — serverless
 * functions cannot write repo files at runtime, so rejections live in Blob
 * and are served through /api/ops.
 */
export async function pushRejected(botId, entry) {
  await blobUpdateJson(KEYS.rejected.path, KEYS.rejected.prefix, (cur) => {
    const all = cur && typeof cur === 'object' ? cur : {};
    all[botId] = [{ ts: new Date().toISOString(), ...entry }, ...(all[botId] || [])].slice(0, 50);
    return all;
  }, {});
}
