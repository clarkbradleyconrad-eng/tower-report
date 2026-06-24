/**
 * Tower Report — /api/stories-db
 *
 * CMS backend for newsroom-authored stories. Stores the full story array
 * as a JSON file in Vercel Blob.
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

import { put, list, del } from '@vercel/blob';

export const config = { runtime: 'edge' };

const BLOB_PATH = 'tower-stories.json';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function blobGet() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return [];
  try {
    const { blobs } = await list({ prefix: BLOB_PATH, token });
    if (!blobs.length) return [];
    const res = await fetch(blobs[0].downloadUrl || blobs[0].url);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function blobSet(stories) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN not configured');
  // Delete the existing blob so we can overwrite at the same path
  const { blobs } = await list({ prefix: BLOB_PATH, token });
  if (blobs.length) {
    await del(blobs.map(b => b.url), { token });
  }
  await put(BLOB_PATH, JSON.stringify(stories), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token,
  });
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
