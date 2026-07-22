/**
 * Tower Report — /api/recruiting-board
 *
 * Recruiting Intelligence Board — live agent-powered database of every
 * Texas Longhorns recruiting target, commit, and watch-list entry.
 *
 * GET  /api/recruiting-board           → serve current board from blob
 * GET  /api/recruiting-board?refresh=1 → run Grok agent, merge updates, write blob
 */

import { readRepoJson } from '../bots/lib/repo.js';
import { blobGetJson, blobPutJson, KEYS } from '../bots/lib/blob.js';
import { loadPromptWithFacts, parseModelJson } from '../bots/lib/prompts.js';

const XAI_API = 'https://api.x.ai/v1/responses';
const TIMEOUT_MS = 110_000;

const STATUS_ORDER = {
  Committed: 0, Priority: 1, 'Trending Up': 2, Target: 3,
  Warm: 4, Cold: 5, 'Trending Down': 6, Decommitted: 7,
};

const POS_GROUP = {
  QB: 'Offense', RB: 'Offense', WR: 'Offense', TE: 'Offense',
  OT: 'Offense', OG: 'Offense', OC: 'Offense', IOL: 'Offense',
  EDGE: 'Defense', DT: 'Defense', LB: 'Defense', CB: 'Defense',
  S: 'Defense', DE: 'Defense', DL: 'Defense',
  K: 'Special Teams', P: 'Special Teams', LS: 'Special Teams',
};

function slugId(name, cls) {
  return `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${cls}`;
}

function posGroup(pos) {
  return POS_GROUP[pos] || 'Defense';
}

function sortRecruits(recruits) {
  return [...recruits].sort((a, b) => {
    const so = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (so !== 0) return so;
    return (b.confidence || 0) - (a.confidence || 0);
  });
}

function dedupeArr(arr, keyFn) {
  const seen = new Set();
  return (arr || []).filter(x => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mergeBoard(existing, update) {
  const recruits = existing?.recruits ? [...existing.recruits] : [];
  const now = new Date().toISOString();

  for (const r of (update.recruits || [])) {
    const { newTimelineEntries = [], isNew, isUpdated, ...fields } = r;

    const idx = recruits.findIndex(e =>
      e.id === r.id || e.name.toLowerCase().trim() === r.name.toLowerCase().trim()
    );

    if (isNew || idx === -1) {
      recruits.push({
        ...fields,
        timeline: newTimelineEntries,
        lastUpdated: now,
      });
    } else {
      const base = recruits[idx];
      const merged = {
        ...base,
        ...fields,
        offers: [...new Set([...(fields.offers || []), ...(base.offers || [])])],
        visits: dedupeArr([...(base.visits || []), ...(fields.visits || [])], v => `${v.date}:${v.school}`),
        crystalBalls: dedupeArr(
          [...(base.crystalBalls || []), ...(fields.crystalBalls || [])],
          c => `${c.predictor}:${c.date}`
        ),
        timeline: [...newTimelineEntries, ...(base.timeline || [])],
        sources: [...new Set([...(base.sources || []), ...(fields.sources || [])])],
        lastUpdated: newTimelineEntries.length ? now : base.lastUpdated,
      };
      recruits[idx] = merged;
    }
  }

  return {
    updated: now,
    summary: update.summary || existing?.summary || '',
    changes: update.changes || existing?.changes || [],
    recruits: sortRecruits(recruits),
  };
}

function seedBoard(recruiting) {
  if (!recruiting) return { recruits: [], updated: null, summary: 'No data yet.', changes: [] };
  const now = new Date().toISOString();
  const cls = recruiting.meta?.cycle || 2027;

  const parseHtWt = (htWt) => {
    const parts = (htWt || '').split(' / ');
    return {
      height: parts[0]?.replace("'", '-').replace('"', '') || '',
      weight: parseInt(parts[1]) || null,
    };
  };

  const parseDate = (dateSort) => {
    if (!dateSort || dateSort > 99990000) return null;
    const s = String(dateSort);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  };

  const commits = (recruiting.commits || []).map(c => {
    const { height, weight } = parseHtWt(c.htWt);
    return {
      id: slugId(c.name, cls),
      name: c.name, class: cls, position: c.pos,
      positionGroup: posGroup(c.pos),
      hometown: c.city || '', highSchool: c.school || '',
      height, weight,
      stars: c.stars || 0,
      on3Rating: parseFloat(c.rating) || null,
      on3Rank: null, rank247: null, rankComposite: null,
      status: 'Committed', confidence: 100,
      committedTo: 'Texas', commitDate: parseDate(c.dateSort),
      offers: ['Texas'], topSchools: [],
      visits: [], crystalBalls: [],
      timeline: [{ ts: now, type: 'commitment', text: `Committed to Texas`, source: 'Verified data', importance: 'high' }],
      sources: ['Verified data'], lastUpdated: now, priority: false,
    };
  });

  const statusMap = { trending: 'Trending Up', monitoring: 'Warm', target: 'Target' };
  const confidenceMap = { trending: 60, monitoring: 35, target: 50 };
  const targets = (recruiting.targets || []).map(t => ({
    id: slugId(t.name, cls),
    name: t.name, class: cls, position: t.pos,
    positionGroup: posGroup(t.pos),
    hometown: t.info?.match(/^([^·]+)·/)?.[1]?.trim() || '',
    highSchool: '',
    height: '', weight: null,
    stars: parseInt(t.info?.match(/(\d)★/)?.[1]) || 0,
    on3Rating: null, on3Rank: null, rank247: null, rankComposite: null,
    status: statusMap[t.status] || 'Target',
    confidence: confidenceMap[t.status] || 50,
    committedTo: null, commitDate: null,
    offers: ['Texas'], topSchools: ['Texas'],
    visits: [], crystalBalls: [],
    timeline: [{ ts: now, type: 'news', text: `Listed as Texas recruiting target`, source: t.source || 'Verified data', importance: 'normal' }],
    sources: [t.source || 'Verified data'], lastUpdated: now, priority: false,
  }));

  return {
    recruits: sortRecruits([...commits, ...targets]),
    updated: null,
    summary: 'Seeded from verified recruiting data. Run a refresh for live intelligence updates.',
    changes: [],
  };
}

async function runAgent(facts) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');

  const existing = await blobGetJson(KEYS.recruitingBoard.prefix);

  // Compact board summary for the prompt (avoid sending full timelines)
  const boardSummary = existing?.recruits?.map(r => ({
    id: r.id, name: r.name, class: r.class, position: r.position,
    status: r.status, confidence: r.confidence, committedTo: r.committedTo,
    lastUpdated: r.lastUpdated,
    recentEvents: (r.timeline || []).slice(0, 3).map(e => e.text),
  })) || [];

  const { text: promptText } = await loadPromptWithFacts('recruiting-board', facts, {
    BOARD_JSON: JSON.stringify({ recruits: boardSummary }, null, 2),
  });

  const xaiRes = await fetch(XAI_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4',
      temperature: 0.15,
      instructions: promptText,
      input: [{ role: 'user', content: 'Search for the latest Texas Longhorns recruiting news and return the board update JSON.' }],
      tools: [{ type: 'web_search' }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!xaiRes.ok) {
    const err = await xaiRes.text().catch(() => '');
    throw new Error(`xAI ${xaiRes.status}: ${err.slice(0, 200)}`);
  }

  const data = await xaiRes.json();
  const content = data.output?.find(o => o.type === 'message')?.content?.[0]?.text || '';
  const update = parseModelJson(content);
  if (!Array.isArray(update?.recruits)) throw new Error('Agent returned no recruits array');

  const merged = mergeBoard(existing, update);
  await blobPutJson(KEYS.recruitingBoard.path, KEYS.recruitingBoard.prefix, merged);
  return { ok: true, updated: merged.updated, count: merged.recruits.length, summary: merged.summary, changes: merged.changes };
}

function jsonRes(res, data, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', status === 200 ? 's-maxage=300, stale-while-revalidate=600' : 'no-store');
  return res.status(status).json(data);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const params = new URLSearchParams((req.url || '').split('?')[1] || '');

  try {
    if (params.get('refresh') === '1') {
      const facts = await readRepoJson('data/facts.json');
      const result = await runAgent(facts);
      return jsonRes(res, result);
    }

    // Serve the current board
    let board = await blobGetJson(KEYS.recruitingBoard.prefix);
    if (!board) {
      const recruiting = await readRepoJson('data/recruiting.json');
      board = seedBoard(recruiting);
    }
    return jsonRes(res, board);

  } catch (err) {
    console.error('[tower/recruiting-board]', err.message);
    return jsonRes(res, { error: err.message }, 500);
  }
}
