/**
 * Tower Report — shared story standards
 *
 * Single source of truth for the accuracy layer used by /api/generate-story
 * and /api/stories-refresh:
 *   - facts prompt block built from data/facts.json (hand-verified ground truth)
 *   - post-generation validation (named sources, real players, impact
 *     breakdown, season model) — stories that fail are rejected, never saved
 *   - similarity dedup (shared players / headline+hook word overlap)
 *
 * Underscore-prefixed path: Vercel does not expose this file as a route.
 */

// The four components of the public Tower AI ranking methodology
// (stories.html ranking modal). Weights: 40 / 25 / 20 / 15.
export const IMPACT_COMPONENTS = [
  'Program & Roster Impact',
  'Fan & Social Velocity',
  'Recruiting/Portal Momentum',
  'Expert Consensus',
];

export const APPROVED_SOURCES = [
  '247Sports', 'On3', 'Inside Texas', 'Orangebloods', 'Burnt Orange Nation',
  'ESPN', 'Austin American-Statesman', 'Rivals', 'Sports Illustrated',
  'CBS Sports', 'The Athletic', 'Yahoo Sports', 'Horns247', 'Longhorns Wire',
];

/* ---- Facts: prompt block ---- */

export function factsPromptBlock(facts) {
  if (!facts) return '';
  const lines = [
    'HAND-VERIFIED PROGRAM FACTS — these override web search results and your training data. Any story that contradicts them will be rejected by an automated check:',
  ];
  if (facts.headCoach) lines.push(`- Head coach: ${facts.headCoach}`);
  if (facts.offensiveCoordinator) lines.push(`- Offensive coordinator: ${facts.offensiveCoordinator}`);
  else lines.push('- Offensive coordinator: NOT VERIFIED — do not name anyone as Texas\'s offensive coordinator or attribute the offense to a coordinator by name.');
  if (facts.defensiveCoordinator) lines.push(`- Defensive coordinator: ${facts.defensiveCoordinator}`);
  else lines.push('- Defensive coordinator: NOT VERIFIED — do not name anyone as Texas\'s defensive coordinator or attribute the defense to a coordinator by name (write "the Texas defensive staff" instead).');
  if (facts.conference) lines.push(`- Conference: ${facts.conference}`);
  if (facts.stadium) lines.push(`- Home stadium: ${facts.stadium}`);
  if (facts.quarterback) lines.push(`- Starting quarterback: ${facts.quarterback}`);
  if (facts.recruiting) {
    lines.push(`- The ${facts.recruiting.signedClass} recruiting class is ${facts.recruiting.signedClassStatus}. The active high-school recruiting cycle is ${facts.recruiting.activeCycle}. Never describe a ${facts.recruiting.signedClass} prospect as an active commit or target.`);
  }
  return lines.join('\n');
}

/* ---- Sourcing + graphics requirements shared by both prompts ---- */

export const SOURCING_RULES = `SOURCING — MANDATORY, STORIES FAILING THIS ARE AUTOMATICALLY REJECTED:
- Every story must be built from at least 2 named outlets found via web search — e.g. ${APPROVED_SOURCES.slice(0, 7).join(', ')}. List each outlet that directly informed the story in the "sources" array (outlet names only, no URLs). An empty or single-source "sources" array is an automatic rejection.
- Only name players who actually appear in those sourced reports. The "players" array must contain real first-and-last names only. Placeholders like "Multiple defensive starters", "Several players", or position groups are an automatic rejection — if you cannot name the players, do not write the story.
- Never invent statistics, rankings, odds, dates, or NIL figures. If search did not confirm it, it does not go in the story.`;

export const GRAPHICS_RULES = `IMPACT BREAKDOWN + SEASON MODEL — REQUIRED ON EVERY STORY (these power on-page graphics; a story without them is rejected):
- "impactBreakdown": exactly 4 entries with these exact labels, mirroring the Tower ranking methodology weights (40% / 25% / 20% / 15%): ${IMPACT_COMPONENTS.map(l => `"${l}"`).join(', ')}. Each entry is {"label": "...", "value": <integer points>}. The four values MUST sum exactly to the story's impact score. Score each component honestly for THIS story (a recruiting commit scores high on Recruiting/Portal Momentum; a depth-chart story scores high on Program & Roster Impact).
- "seasonModel": an object with 3-4 rows of concrete, story-specific projections grounded in the sourced reporting — keys like "CFP Odds Shift", "Depth Chart Effect", "Next Game Relevance", "Recruiting Board Effect"; values are short concrete phrases (e.g. "OL depth now two-deep at both tackle spots"), never generic filler.`;

/* ---- Validation ---- */

const PLAYER_PLACEHOLDER = /\b(multiple|various|several|numerous|unnamed|unknown|tbd|placeholder|starters|players|position group|defenders|linemen|receivers)\b/i;

function collectText(story) {
  const parts = [];
  for (const v of Object.values(story || {})) {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter(x => typeof x === 'string').join(' '));
    else if (v && typeof v === 'object') parts.push(Object.values(v).filter(x => typeof x === 'string').join(' '));
  }
  return parts.join(' ');
}

function coordinatorConflicts(text, facts) {
  const reasons = [];
  // Name = capitalized words only; no "." in the class — it swallowed
  // sentence boundaries ("head coach Steve Sarkisian. No…") and produced
  // false rejections. A one-word match ("coach Sarkisian") passes when it
  // is contained in the verified full name.
  const roleRe = /(head coach|offensive coordinator|defensive coordinator)\s+([A-Z][\w'’-]+(?:\s+[A-Z][\w'’-]+)*)/g;
  const factFor = {
    'head coach': facts?.headCoach,
    'offensive coordinator': facts?.offensiveCoordinator,
    'defensive coordinator': facts?.defensiveCoordinator,
  };
  let m;
  while ((m = roleRe.exec(text))) {
    const role = m[1].toLowerCase();
    const name = m[2].trim();
    const expected = factFor[role];
    if (expected) {
      const a = name.toLowerCase(), b = expected.toLowerCase();
      if (!a.includes(b) && !b.includes(a)) {
        reasons.push(`names "${name}" as ${role}; verified facts say ${expected}`);
      }
    } else if (role !== 'head coach') {
      reasons.push(`attributes the ${role} role to "${name}" — that role is unverified in data/facts.json`);
    }
  }
  // Unverified coordinator candidates must not appear at all until confirmed
  for (const cand of facts?.unverified?.defensiveCoordinator || []) {
    if (!facts?.defensiveCoordinator && text.includes(cand)) {
      reasons.push(`mentions "${cand}" while the DC role is unverified (see NEEDS-VERIFICATION.md)`);
    }
  }
  return reasons;
}

/**
 * Validate one generated story against Tower standards + facts.json.
 * Field names cover both schemas (stories-refresh: headline/hook,
 * generate-story: title/summary). Returns { ok, reasons }.
 */
export function validateStory(story, facts) {
  const reasons = [];
  const s = story || {};

  const sources = (s.sources || []).map(x => String(x).trim()).filter(Boolean);
  if (sources.length < 2) reasons.push(`needs >=2 named sources, got ${sources.length}`);

  const players = (s.players || []).map(x => String(x).trim()).filter(Boolean);
  if (!players.length) reasons.push('players array is empty');
  for (const p of players) {
    if (PLAYER_PLACEHOLDER.test(p) || p.split(/\s+/).length < 2) {
      reasons.push(`players contains a placeholder or non-name: "${p}"`);
    }
  }

  const breakdown = Array.isArray(s.impactBreakdown) ? s.impactBreakdown : [];
  if (breakdown.length !== 4) {
    reasons.push(`impactBreakdown must have exactly 4 components, got ${breakdown.length}`);
  } else {
    const labels = breakdown.map(b => String(b.label || '').toLowerCase());
    for (const want of IMPACT_COMPONENTS) {
      const key = want.toLowerCase().replace(/[^a-z]/g, '');
      if (!labels.some(l => l.replace(/[^a-z]/g, '') === key)) {
        reasons.push(`impactBreakdown missing component "${want}"`);
      }
    }
    if (breakdown.some(b => !Number.isFinite(Number(b.value)) || Number(b.value) < 0)) {
      reasons.push('impactBreakdown values must be non-negative numbers');
    }
  }

  const model = s.seasonModel;
  const modelRows = model && typeof model === 'object' && !Array.isArray(model)
    ? Object.entries(model).filter(([k, v]) => k && typeof v === 'string' && v.trim())
    : [];
  if (modelRows.length < 3) reasons.push(`seasonModel needs 3-4 concrete rows, got ${modelRows.length}`);

  if (!(s.affectedPositions || []).length) reasons.push('affectedPositions is empty');
  if ((s.takeaways || []).length < 2) reasons.push('takeaways underpopulated');
  if ((s.watchNext || []).length < 2) reasons.push('watchNext underpopulated');

  const text = collectText(s);
  reasons.push(...coordinatorConflicts(text, facts));

  if (facts?.recruiting) {
    const y = facts.recruiting.signedClass;
    const closedClassRe = new RegExp(
      `(commits?|committed|pledges?|pledged|flips?|flipped|decommits?|top targets?)[^.]{0,80}\\b${y}\\s+class|\\b${y}\\s+class[^.]{0,80}(commits?|committed|pledges?|pledged|flips?|flipped|decommits?|top targets?)`, 'i');
    if (closedClassRe.test(text)) {
      reasons.push(`describes active ${y}-class recruiting; facts.json says the ${y} class is signed/closed (active cycle: ${facts.recruiting.activeCycle})`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Force impactBreakdown into canonical label order and rescale the values so
 * they sum exactly to the impact score (fixes model arithmetic drift without
 * rejecting an otherwise-valid story).
 */
export function normalizeImpactBreakdown(story) {
  const impact = Number(story.impact || story.impactScore) || 0;
  const raw = Array.isArray(story.impactBreakdown) ? story.impactBreakdown : [];
  if (raw.length !== 4 || !impact) return story;

  const byKey = {};
  for (const b of raw) byKey[String(b.label || '').toLowerCase().replace(/[^a-z]/g, '')] = Number(b.value) || 0;
  const values = IMPACT_COMPONENTS.map(l => byKey[l.toLowerCase().replace(/[^a-z]/g, '')] || 0);
  const sum = values.reduce((a, b) => a + b, 0);
  let scaled;
  if (!sum) {
    // Degenerate all-zero breakdown: fall back to the methodology weights
    scaled = [0.40, 0.25, 0.20, 0.15].map(w => Math.round(impact * w));
  } else {
    scaled = values.map(v => Math.round((v / sum) * impact));
  }
  // Rounding drift lands on the largest component
  const drift = impact - scaled.reduce((a, b) => a + b, 0);
  scaled[scaled.indexOf(Math.max(...scaled))] += drift;

  story.impactBreakdown = IMPACT_COMPONENTS.map((label, i) => ({ label, value: scaled[i] }));
  return story;
}

/* ---- Similarity dedup ---- */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'as', 'at', 'by', 'with',
  'is', 'are', 'was', 'were', 'his', 'her', 'their', 'its', 'into', 'from', 'after', 'before',
  'what', 'why', 'how', 'texas', 'longhorns', 'longhorn', 'football', 'this', 'that', 'over',
  '2025', '2026', '2027', '2028',
]);

function contentTokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w)));
}

function playerSet(story) {
  return new Set((story.players || []).map(p => String(p).toLowerCase().trim()).filter(Boolean));
}

function overlapCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

/**
 * Two stories are duplicates when, within the dedup window:
 *   - same category AND they share >=2 named players, OR
 *   - headline+hook word overlap >= 55%
 */
export function isDuplicatePair(a, b) {
  const sharedPlayers = overlapCount(playerSet(a), playerSet(b));
  if (a.category && a.category === b.category && sharedPlayers >= 2) return true;
  const headA = contentTokens(a.headline || a.title || '');
  const headB = contentTokens(b.headline || b.title || '');
  // Headline-only comparison catches retellings of the same event whose long
  // hooks dilute the combined overlap below threshold
  if (overlapCoefficient(headA, headB) >= 0.55) return true;
  const ta = contentTokens(`${a.headline || a.title || ''} ${a.hook || a.summary || ''}`);
  const tb = contentTokens(`${b.headline || b.title || ''} ${b.hook || b.summary || ''}`);
  return overlapCoefficient(ta, tb) >= 0.55;
}

function overlapCount(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function storyTime(s) {
  const t = new Date(s._generated || s.date || 0).getTime();
  return isNaN(t) ? 0 : t;
}

export const DEDUP_WINDOW_MS = 10 * 24 * 3600 * 1000;

/**
 * Pairwise-dedupe a story list: for every duplicate pair within the window,
 * keep the higher-impact story (ties keep the newer one).
 * Returns { kept, removed } — removed carries { id, headline, keptId }.
 */
export function dedupeArchive(stories) {
  const list = [...(stories || [])];
  const removed = [];
  const dead = new Set();
  for (let i = 0; i < list.length; i++) {
    if (dead.has(i)) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (dead.has(j)) continue;
      const a = list[i], b = list[j];
      if (Math.abs(storyTime(a) - storyTime(b)) > DEDUP_WINDOW_MS) continue;
      if (!isDuplicatePair(a, b)) continue;
      const impA = Number(a.impact || a.impactScore) || 0;
      const impB = Number(b.impact || b.impactScore) || 0;
      const loserIdx = impA > impB ? j : impB > impA ? i : (storyTime(a) >= storyTime(b) ? j : i);
      const winnerIdx = loserIdx === i ? j : i;
      dead.add(loserIdx);
      removed.push({
        id: list[loserIdx].id || null,
        headline: list[loserIdx].headline || list[loserIdx].title || '',
        keptId: list[winnerIdx].id || null,
      });
      if (loserIdx === i) break; // story i is gone; stop comparing it
    }
  }
  return { kept: list.filter((_, idx) => !dead.has(idx)), removed };
}
