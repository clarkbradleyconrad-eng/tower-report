/**
 * Tower Report bots — output quality scoring
 *
 * Every scoreable bot output gets a 0-100 grade. Below REJECT_THRESHOLD the
 * output is not published; it goes to the per-bot rejection queue in Blob
 * (see blob.js pushRejected) for review on ops.html.
 *
 * Story scoring components (100 pts):
 *   25 — sourcing: >=2 named outlets, bonus for approved beat outlets
 *   20 — players: real first-and-last names, no placeholders
 *   20 — impactBreakdown: 4 canonical components summing to the impact score
 *   20 — facts.json consistency: no staff-name or closed-class conflicts
 *   15 — field completeness across the story schema
 */

import { IMPACT_COMPONENTS, APPROVED_SOURCES, validateStory } from '../../api/_lib/story-standards.js';

export const REJECT_THRESHOLD = 60;

const PLACEHOLDER = /\b(multiple|various|several|numerous|unnamed|unknown|tbd|placeholder|starters|position group)\b/i;

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/* ---- Stories (stories-refresh + story-generator schemas) ---- */

export function scoreStory(story, facts) {
  const s = story || {};
  const reasons = [];
  let pts = 0;

  // Sourcing — 25
  const sources = (s.sources || []).map(x => String(x).trim()).filter(Boolean);
  if (sources.length >= 2) pts += 15;
  else reasons.push(`sourcing: only ${sources.length} named outlet(s)`);
  const approved = sources.filter(src =>
    APPROVED_SOURCES.some(a => src.toLowerCase().includes(a.toLowerCase())));
  pts += Math.min(10, approved.length * 5);
  if (sources.length >= 2 && !approved.length) reasons.push('sourcing: no recognized beat outlet');

  // Players — 20
  const players = (s.players || []).map(x => String(x).trim()).filter(Boolean);
  const real = players.filter(p => p.split(/\s+/).length >= 2 && !PLACEHOLDER.test(p));
  if (players.length && real.length === players.length) pts += 20;
  else if (real.length) { pts += 10; reasons.push('players: contains placeholder entries'); }
  else reasons.push('players: no real named players');

  // Impact breakdown — 20
  const impact = Number(s.impact || s.impactScore) || 0;
  const breakdown = Array.isArray(s.impactBreakdown) ? s.impactBreakdown : [];
  const canon = (l) => String(l || '').toLowerCase().replace(/[^a-z]/g, '');
  const labels = breakdown.map(b => canon(b.label));
  const allLabels = breakdown.length === 4
    && IMPACT_COMPONENTS.every(want => labels.includes(canon(want)));
  if (allLabels) pts += 10;
  else reasons.push('impactBreakdown: missing or mislabeled components');
  const sum = breakdown.reduce((a, b) => a + (Number(b.value) || 0), 0);
  if (impact && sum === impact) pts += 10;
  else reasons.push(`impactBreakdown: components sum to ${sum}, impact is ${impact}`);

  // Facts consistency — 20
  const factConflicts = validateStory(s, facts).reasons
    .filter(r => /coordinator|facts|class is signed|unverified/i.test(r));
  pts += Math.max(0, 20 - factConflicts.length * 10);
  reasons.push(...factConflicts.map(r => `facts: ${r}`));

  // Completeness — 15 (covers both story schemas)
  const fields = [
    s.headline || s.title,
    s.hook || s.summary,
    s.whatHappened,
    s.whyItMatters,
    s.footballImpact || s.impactOnTexas,
    s.towerTake || s.futureOutlook,
    (s.takeaways || s.keySignals || []).length >= 2,
    (s.watchNext || []).length >= 2,
    (s.affectedPositions || []).length >= 1,
    s.seasonModel && Object.keys(s.seasonModel).length >= 3,
  ];
  const present = fields.filter(Boolean).length;
  pts += Math.round((present / fields.length) * 15);
  if (present < fields.length) reasons.push(`completeness: ${present}/${fields.length} sections filled`);

  return { score: clamp(pts), reasons };
}

/* ---- Briefing items ---- */

export function scoreBriefing(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { score: 0, reasons: ['no briefing items'] };
  const reasons = [];
  const per = list.map(it => {
    let pts = 0;
    const sections = ['headline', 'context', 'whatHappened', 'whyItMatters', 'whatNext'];
    const filled = sections.filter(k => String(it[k] || '').trim().length > 10).length;
    pts += Math.round((filled / sections.length) * 40);
    if (String(it.source || '').trim()) pts += 20;
    if (/^https?:\/\//.test(String(it.url || ''))) pts += 15;
    if (['RECRUITING', 'ROSTER', 'PORTAL', 'PROGRAM', 'INTEL', 'INJURY', 'NIL'].includes(String(it.category || '').toUpperCase())) pts += 10;
    if (['HIGH', 'NORMAL', 'URGENT'].includes(String(it.importance || '').toUpperCase())) pts += 5;
    if (!PLACEHOLDER.test(`${it.headline} ${it.context}`)) pts += 10;
    return clamp(pts);
  });
  const score = clamp(per.reduce((a, b) => a + b, 0) / per.length);
  if (list.length < 5) reasons.push(`only ${list.length}/5 briefing items`);
  const weak = per.filter(p => p < 60).length;
  if (weak) reasons.push(`${weak} item(s) scored under 60`);
  return { score: list.length < 5 ? clamp(score - (5 - list.length) * 10) : score, reasons, per };
}

/* ---- Social drafts ---- */

export function scoreSocial(drafts) {
  const list = Array.isArray(drafts) ? drafts : [];
  const reasons = [];
  let pts = 0;
  if (list.length >= 3) pts += 30;
  else reasons.push(`only ${list.length}/3 drafts`);
  const texts = list.map(d => String(d.text || '').trim());
  const okLen = texts.filter(t => t.length > 0 && t.length <= 280).length;
  pts += Math.round((okLen / Math.max(3, list.length)) * 30);
  if (okLen < list.length) reasons.push('draft(s) empty or over 280 chars');
  const substantive = texts.filter(t => t.length >= 60 && !PLACEHOLDER.test(t)).length;
  pts += Math.round((substantive / Math.max(3, list.length)) * 25);
  if (substantive < list.length) reasons.push('draft(s) thin or placeholder-y');
  const styles = new Set(list.map(d => String(d.style || '').toLowerCase()).filter(Boolean));
  if (styles.size >= 3) pts += 15;
  else reasons.push('drafts do not cover 3 distinct styles');
  return { score: clamp(pts), reasons };
}

/* ---- Live recruiting snapshot ---- */

export function scoreRecruitingLive(live) {
  const l = live || {};
  const reasons = [];
  let pts = 0;
  const sources = (l.sources || []).filter(Boolean);
  pts += Math.min(40, sources.length * 20);
  if (!sources.length) reasons.push('no named sources');
  if (l.on3TeamRank != null || l.sports247TeamRank != null) pts += 30;
  else reasons.push('no team rank verified (nulls are honest but score low)');
  if (l.commitCount != null) pts += 15;
  else reasons.push('commit count unverified');
  if (Array.isArray(l.recentMoves)) pts += 15;
  return { score: clamp(pts), reasons };
}

/* ---- Dispatcher ---- */

/**
 * Grade any bot output by its registry outputType.
 * ctx: { facts } for story types.
 */
export function scoreOutput(outputType, output, ctx = {}) {
  switch (outputType) {
    case 'story':
      return scoreStory(output, ctx.facts);
    case 'stories': {
      const list = Array.isArray(output) ? output : [];
      if (!list.length) return { score: 0, reasons: ['no stories'] };
      const per = list.map(st => scoreStory(st, ctx.facts));
      return {
        score: clamp(per.reduce((a, b) => a + b.score, 0) / per.length),
        reasons: per.flatMap((r, i) => r.reasons.map(x => `story ${i + 1}: ${x}`)),
        per: per.map(r => r.score),
      };
    }
    case 'briefing':
      return scoreBriefing(output);
    case 'social':
      return scoreSocial(output);
    case 'recruiting-live':
      return scoreRecruitingLive(output);
    default:
      return { score: null, reasons: [] };
  }
}
