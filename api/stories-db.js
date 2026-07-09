/**
 * Tower Report — /api/stories-db
 *
 * CMS backend for newsroom-authored stories. Stores the story array
 * as a JSON file in Vercel Blob via the REST API (no npm package,
 * edge-runtime safe).
 *
 * Methods:
 *   GET    — returns { stories: [...] }
 *   POST   — upsert a story by id: body { story }
 *   PATCH  — partial update: body { id, updates }
 *   DELETE — remove by id: ?id=...
 *
 * Env vars:
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token (already configured)
 */

export const config = { runtime: 'edge' };

const BLOB_PATHNAME = 'tower-stories.json';
const BLOB_PREFIX = 'tower-stories'; // prefix without .json — REST API appends random hash to URL
const BLOB_API = 'https://blob.vercel-storage.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Desk-Key, Authorization',
};

// Mutations require the desk key (X-Desk-Key) or the cron secret (Bearer)
// once either env var is configured. With neither set, behavior is unchanged
// (open) so the newsroom keeps working before the env is provisioned.
function authorized(req) {
  const desk = process.env.DESK_PASSWORD;
  const cron = process.env.CRON_SECRET;
  if (!desk && !cron) return true;
  const key = req.headers.get('x-desk-key') || '';
  const bearer = req.headers.get('authorization') || '';
  return (desk && key === desk) || (cron && bearer === `Bearer ${cron}`);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function blobList(token) {
  const url = `${BLOB_API}?prefix=${encodeURIComponent(BLOB_PREFIX)}&limit=10`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const data = await res.json();
  const blobs = data.blobs || [];
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return blobs[0] ?? null;
}

async function blobGet() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return [];
  try {
    const blob = await blobList(token);
    if (!blob) return [];
    const res = await fetch(blob.downloadUrl || blob.url);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function blobSet(stories) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN not configured');

  // Delete ALL existing blobs for this key (REST API appends random hash, so orphans accumulate)
  const listUrl = `${BLOB_API}?prefix=${encodeURIComponent(BLOB_PREFIX)}&limit=50`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (listRes.ok) {
    const listData = await listRes.json();
    const existingUrls = (listData.blobs || []).map(b => b.url);
    if (existingUrls.length) {
      await fetch(BLOB_API, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: existingUrls }),
      });
    }
  }

  // Upload new blob
  const putUrl = `${BLOB_API}/${BLOB_PATHNAME}?addRandomSuffix=0`;
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(stories),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Blob write failed: ${err}`);
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    if (req.method === 'GET') {
      const stories = await blobGet();
      return json({ stories });
    }

    // Everything past this point mutates the archive
    if (!authorized(req)) return json({ error: 'Unauthorized' }, 401);

    if (req.method === 'POST') {
      const body = await req.json();
      const story = body.story;
      if (!story?.id) return json({ error: 'Missing story.id' }, 400);
      const stories = await blobGet();
      const idx = stories.findIndex(s => s.id === story.id);
      if (idx >= 0) stories[idx] = story;
      else stories.unshift(story);
      await blobSet(stories);
      return json({ ok: true, story });
    }

    if (req.method === 'PATCH') {
      const { id, updates } = await req.json();
      if (!id) return json({ error: 'Missing id' }, 400);
      const stories = await blobGet();
      const idx = stories.findIndex(s => s.id === id);
      if (idx < 0) return json({ error: 'Story not found' }, 404);
      stories[idx] = { ...stories[idx], ...updates };
      await blobSet(stories);
      return json({ ok: true, story: stories[idx] });
    }

    if (req.method === 'DELETE') {
      const id = new URL(req.url).searchParams.get('id');
      if (!id) return json({ error: 'Missing id param' }, 400);
      const stories = await blobGet();
      const filtered = stories.filter(s => s.id !== id);
      if (filtered.length === stories.length) return json({ error: 'Story not found' }, 404);
      await blobSet(filtered);
      return json({ ok: true });
    }

    return new Response('Method not allowed', { status: 405, headers: CORS });
  } catch (err) {
    console.error('[tower/stories-db]', err.message);
    return json({ error: err.message }, 500);
  }
}
