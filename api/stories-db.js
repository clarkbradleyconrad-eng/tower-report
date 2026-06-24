/**
 * Tower Report — /api/stories-db
 *
 * CMS backend for newsroom-authored stories. Stores the full story array
 * as a JSON string in Vercel KV (Upstash REST API).
 *
 * Methods:
 *   GET    — returns { stories: [...] }
 *   POST   — upsert a story by id: body { story }
 *   PATCH  — partial update: body { id, updates }
 *   DELETE — remove by id: ?id=...
 *
 * Env vars:
 *   KV_REST_API_URL   — Vercel KV endpoint
 *   KV_REST_API_TOKEN — Vercel KV auth token
 */

export const config = { runtime: 'edge' };

const KV_KEY = 'tower:stories';

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

async function kvGet() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return [];
  const res = await fetch(`${url}/get/${KV_KEY}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  if (!data.result) return [];
  return JSON.parse(data.result);
}

async function kvSet(stories) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV not configured — set KV_REST_API_URL and KV_REST_API_TOKEN');
  const res = await fetch(`${url}/set/${KV_KEY}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(JSON.stringify(stories)),
  });
  if (!res.ok) throw new Error(`KV write failed: ${res.status}`);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    if (req.method === 'GET') {
      const stories = await kvGet();
      return json({ stories });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const story = body.story;
      if (!story?.id) return json({ error: 'Missing story.id' }, 400);
      const stories = await kvGet();
      const idx = stories.findIndex(s => s.id === story.id);
      if (idx >= 0) stories[idx] = story;
      else stories.unshift(story);
      await kvSet(stories);
      return json({ ok: true, story });
    }

    if (req.method === 'PATCH') {
      const { id, updates } = await req.json();
      if (!id) return json({ error: 'Missing id' }, 400);
      const stories = await kvGet();
      const idx = stories.findIndex(s => s.id === id);
      if (idx < 0) return json({ error: 'Story not found' }, 404);
      stories[idx] = { ...stories[idx], ...updates };
      await kvSet(stories);
      return json({ ok: true, story: stories[idx] });
    }

    if (req.method === 'DELETE') {
      const id = new URL(req.url).searchParams.get('id');
      if (!id) return json({ error: 'Missing id param' }, 400);
      const stories = await kvGet();
      const filtered = stories.filter(s => s.id !== id);
      if (filtered.length === stories.length) return json({ error: 'Story not found' }, 404);
      await kvSet(filtered);
      return json({ ok: true });
    }

    return new Response('Method not allowed', { status: 405, headers: CORS });
  } catch (err) {
    console.error('[tower/stories-db]', err.message);
    return json({ error: err.message }, 500);
  }
}
