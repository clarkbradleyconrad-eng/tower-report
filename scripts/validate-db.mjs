#!/usr/bin/env node
/**
 * Tower Report — data-layer integrity check.
 * Validates data/db.json: required fields per collection and that every
 * cross-reference (opponentId, teamId, playerIds, gameIds, storyIds)
 * resolves to a real entity. Exits 1 on any violation.
 *
 * Run after any hand-edit to db.json:  node scripts/validate-db.mjs
 */
import { readFile } from 'node:fs/promises';

const db = JSON.parse(await readFile(new URL('../data/db.json', import.meta.url), 'utf8'));
const errors = [];
const collections = ['teams', 'players', 'games', 'stories'];

for (const c of collections) {
  if (!db[c] || typeof db[c] !== 'object') errors.push(`missing collection: ${c}`);
}

const has = (coll, id) => !!(db[coll] && db[coll][id]);

for (const [id, t] of Object.entries(db.teams ?? {})) {
  if (t.id !== id) errors.push(`teams/${id}: id field mismatch (${t.id})`);
  if (!t.name) errors.push(`teams/${id}: missing name`);
}

for (const [id, p] of Object.entries(db.players ?? {})) {
  if (p.id !== id) errors.push(`players/${id}: id field mismatch (${p.id})`);
  if (!p.name || !p.position) errors.push(`players/${id}: missing name/position`);
  if (p.teamId && !has('teams', p.teamId)) errors.push(`players/${id}: unknown teamId ${p.teamId}`);
}

for (const [id, g] of Object.entries(db.games ?? {})) {
  if (g.id !== id) errors.push(`games/${id}: id field mismatch (${g.id})`);
  if (g.era !== 'historic') {
    if (!g.dateISO) errors.push(`games/${id}: schedule game missing dateISO`);
    if (!g.opponentId) errors.push(`games/${id}: missing opponentId`);
    else if (!has('teams', g.opponentId)) errors.push(`games/${id}: unknown opponentId ${g.opponentId}`);
  }
  for (const pid of g.playerIds ?? []) if (!has('players', pid)) errors.push(`games/${id}: unknown playerId ${pid}`);
  for (const sid of g.storyIds ?? []) if (!has('stories', sid)) errors.push(`games/${id}: unknown storyId ${sid}`);
}

for (const [id, s] of Object.entries(db.stories ?? {})) {
  if (s.id !== id) errors.push(`stories/${id}: id field mismatch (${s.id})`);
  if (!s.title || !s.url) errors.push(`stories/${id}: missing title/url`);
  if (!['page', 'archive'].includes(s.type)) errors.push(`stories/${id}: bad type ${s.type}`);
  for (const pid of s.playerIds ?? []) if (!has('players', pid)) errors.push(`stories/${id}: unknown playerId ${pid}`);
  for (const gid of s.gameIds ?? []) if (!has('games', gid)) errors.push(`stories/${id}: unknown gameId ${gid}`);
}

const counts = collections.map(c => `${Object.keys(db[c] ?? {}).length} ${c}`).join(', ');
if (errors.length) {
  console.error(`db.json INVALID (${counts}):`);
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}
console.log(`db.json valid — ${counts}, all cross-references resolve.`);
