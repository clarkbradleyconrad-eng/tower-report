/**
 * Tower Report — /api/x-queue
 *
 * CRUD for the X post queue.
 *
 * GET    /api/x-queue             — list all queue items (newest first)
 * GET    /api/x-queue?status=...  — filter by status (pending|approved|rejected|scheduled|posted)
 * POST   /api/x-queue             — add item(s) to queue (body: { posts: [...] })
 * PATCH  /api/x-queue?id=...      — update one item (body: { status, text, scheduledFor, ... })
 * DELETE /api/x-queue?id=...      — remove one item from queue
 *
 * Queue schema per item:
 *   id, format, text, confidence, sources[], hasLink, linkUrl, linkPage,
 *   rationale, priority, status (pending|approved|rejected|scheduled|posted),
 *   scheduledFor (ISO string or null), tweetId (after posting), tweetUrl,
 *   postedAt, createdAt, editedAt
 *
 * Auth: OPS_KEY header (x-ops-key) or ?key= param
 * Env: BLOB_READ_WRITE_TOKEN
 */

import { blobGetJson, blobPutJson } from '../bots/lib/blob.js';
import { randomUUID } from 'node:crypto';

const QUEUE_PATH   = 'tower-x-queue.json';
const QUEUE_PREFIX = 'tower-x-queue';
const MAX_QUEUE    = 500;

function authOk(req) {
  const key = process.env.OPS_KEY;
  if (!key) return true;
  const h = req.headers['x-ops-key'] || '';
  const p = new URL(req.url, 'http://localhost').searchParams.get('key') || '';
  return h === key || p === key;
}

async function readQueue() {
  return (await blobGetJson(QUEUE_PREFIX)) || [];
}

async function writeQueue(items) {
  await blobPutJson(QUEUE_PATH, QUEUE_PREFIX, items.slice(0, MAX_QUEUE));
}

export default async function handler(req, res) {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });

  const url    = new URL(req.url, 'http://localhost');
  const itemId = url.searchParams.get('id');

  if (req.method === 'GET') {
    let items = await readQueue();
    const status = url.searchParams.get('status');
    if (status) items = items.filter(i => i.status === status);
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.status(200).json({ ok: true, count: items.length, items });
  }

  if (req.method === 'POST') {
    let body;
    try { body = typeof req.body === 'object' ? req.body : JSON.parse(req.body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    const incoming = Array.isArray(body?.posts) ? body.posts : (body ? [body] : []);
    if (!incoming.length) return res.status(400).json({ error: 'posts[] required' });

    const now   = new Date().toISOString();
    const queue = await readQueue();
    const added = [];

    for (const p of incoming) {
      if (!p.text) continue;
      const item = {
        id:           p.id || randomUUID(),
        format:       p.format || 'analysis',
        text:         String(p.text).slice(0, 280),
        confidence:   p.confidence || 'reported',
        sources:      Array.isArray(p.sources) ? p.sources : [],
        hasLink:      !!p.hasLink,
        linkUrl:      p.linkUrl || null,
        linkPage:     p.linkPage || null,
        rationale:    p.rationale || '',
        priority:     p.priority || 99,
        status:       p.status || 'pending',
        scheduledFor: p.scheduledFor || null,
        tweetId:      null,
        tweetUrl:     null,
        postedAt:     null,
        generatedBy:  p.generatedBy || 'manual',
        createdAt:    now,
        editedAt:     null,
      };
      queue.unshift(item);
      added.push(item);
    }

    await writeQueue(queue);
    return res.status(200).json({ ok: true, added: added.length, items: added });
  }

  if (req.method === 'PATCH') {
    if (!itemId) return res.status(400).json({ error: 'id param required' });
    let body;
    try { body = typeof req.body === 'object' ? req.body : JSON.parse(req.body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    const queue = await readQueue();
    const idx   = queue.findIndex(i => i.id === itemId);
    if (idx === -1) return res.status(404).json({ error: 'Item not found' });

    const allowed = ['text', 'status', 'scheduledFor', 'confidence', 'hasLink', 'linkUrl', 'linkPage', 'tweetId', 'tweetUrl', 'postedAt'];
    for (const k of allowed) {
      if (k in body) queue[idx][k] = body[k];
    }
    queue[idx].editedAt = new Date().toISOString();

    await writeQueue(queue);
    return res.status(200).json({ ok: true, item: queue[idx] });
  }

  if (req.method === 'DELETE') {
    if (!itemId) return res.status(400).json({ error: 'id param required' });
    const queue  = await readQueue();
    const before = queue.length;
    const next   = queue.filter(i => i.id !== itemId);
    if (next.length === before) return res.status(404).json({ error: 'Item not found' });
    await writeQueue(next);
    return res.status(200).json({ ok: true, deleted: before - next.length });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
