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

/* ---- Substance metrics ----
   Depth = density of verifiable specifics, not word count. A padded story
   repeats the same ideas across sections with no numbers, dates, or
   rankings — these metrics catch exactly that and cap the score below the
   reject threshold, so padding can never buy a passing grade. */

const STORY_SECTIONS = ['hook', 'whatHappened', 'whyItMatters', 'footballImpact',
  'impactOnTexas', 'whatChanges', 'towerTake', 'futureOutlook', 'summary'];

const FILLER = /\b(standard (offseason )?evaluation timelines?|remains to be seen|only time will tell|consensus (view|read) is|it is (unclear|uncertain) (whether|how)|will be (interesting|key|crucial) to watch|could go either way|time will tell|per recent reporting|according to reports\b)/gi;

// Concrete, checkable specifics: counts, rankings, dates, measurements, records
const CONCRETE = /\b(\d[\d,.]*(?:%|st|nd|rd|th)?|no\.\s?\d+|#\d+|[3-5]-star|five-star|four-star|three-star|\d-\d(?:\d)?|january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;

function sectionTexts(story) {
  return STORY_SECTIONS
    .map(k => [k, String(story?.[k] || '').trim()])
    .filter(([, v]) => v.length > 0);
}

/** Concrete specifics per 100 words across all narrative sections. */
export function factDensity(story) {
  const text = sectionTexts(story).map(([, v]) => v).join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!words) return { per100: 0, count: 0, words: 0 };
  const count = (text.match(CONCRETE) || []).length;
  return { per100: (count / words) * 100, count, words };
}

/**
 * Cross-section repetition: fraction of 4-word shingles in each section that
 * already appeared in an earlier section. Padded stories recycle the same
 * phrases; genuinely deep stories advance a new argument per section.
 */
export function repetitionRatio(story) {
  const seen = new Set();
  let repeated = 0, total = 0;
  for (const [, text] of sectionTexts(story)) {
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const local = [];
    for (let i = 0; i + 4 <= words.length; i++) {
      const sh = words.slice(i, i + 4).join(' ');
      total++;
      if (seen.has(sh)) repeated++;
      local.push(sh);
    }
    for (const sh of local) seen.add(sh);
  }
  return total ? repeated / total : 0;
}

/** 0-25 substance points + hard caps. Returns { pts, cap, reasons }. */
function substanceScore(story) {
  const reasons = [];
  let pts = 0;
  let cap = 100;

  const density = factDensity(story);
  // Solid beat writing runs ~2.5-5 concrete specifics per 100 words
  if (density.per100 >= 2.0) pts += 15;
  else if (density.per100 >= 1.2) { pts += 8; reasons.push(`substance: thin fact density (${density.per100.toFixed(1)} specifics/100w, want 2.0+)`); }
  else {
    reasons.push(`substance: hollow — ${density.count} concrete specifics in ${density.words} words (${density.per100.toFixed(1)}/100w)`);
    cap = Math.min(cap, 50); // hard fail: word count without facts is padding
  }

  const rep = repetitionRatio(story);
  if (rep <= 0.04) pts += 10;
  else if (rep <= 0.10) { pts += 4; reasons.push(`substance: noticeable cross-section repetition (${(rep * 100).toFixed(0)}%)`); }
  else {
    reasons.push(`substance: sections recycle the same phrases (${(rep * 100).toFixed(0)}% repeated shingles)`);
    cap = Math.min(cap, 50); // hard fail: expansion by repetition
  }

  const fillerHits = (sectionTexts(story).map(([, v]) => v).join(' ').match(FILLER) || []);
  if (fillerHits.length) {
    pts = Math.max(0, pts - fillerHits.length * 3);
    reasons.push(`substance: filler phrases (${[...new Set(fillerHits.map(f => f.toLowerCase()))].slice(0, 3).join('; ')})`);
  }

  return { pts, cap, reasons };
}

/* ---- Stories (stories-refresh + story-generator schemas) ---- */

export function scoreStory(story, facts) {
  const s = story || {};
  const reasons = [];
  let pts = 0;

  // Sourcing — 15
  const sources = (s.sources || []).map(x => String(x).trim()).filter(Boolean);
  if (sources.length >= 2) pts += 9;
  else reasons.push(`sourcing: only ${sources.length} named outlet(s)`);
  const approved = sources.filter(src =>
    APPROVED_SOURCES.some(a => src.toLowerCase().includes(a.toLowerCase())));
  pts += Math.min(6, approved.length * 3);
  if (sources.length >= 2 && !approved.length) reasons.push('sourcing: no recognized beat outlet');

  // Players — 15
  const players = (s.players || []).map(x => String(x).trim()).filter(Boolean);
  const real = players.filter(p => p.split(/\s+/).length >= 2 && !PLACEHOLDER.test(p));
  if (players.length && real.length === players.length) pts += 15;
  else if (real.length) { pts += 7; reasons.push('players: contains placeholder entries'); }
  else reasons.push('players: no real named players');

  // Impact breakdown — 15
  const impact = Number(s.impact || s.impactScore) || 0;
  const breakdown = Array.isArray(s.impactBreakdown) ? s.impactBreakdown : [];
  const canon = (l) => String(l || '').toLowerCase().replace(/[^a-z]/g, '');
  const labels = breakdown.map(b => canon(b.label));
  const allLabels = breakdown.length === 4
    && IMPACT_COMPONENTS.every(want => labels.includes(canon(want)));
  if (allLabels) pts += 8;
  else reasons.push('impactBreakdown: missing or mislabeled components');
  const sum = breakdown.reduce((a, b) => a + (Number(b.value) || 0), 0);
  if (impact && sum === impact) pts += 7;
  else reasons.push(`impactBreakdown: components sum to ${sum}, impact is ${impact}`);

  // Facts consistency — 20
  const factConflicts = validateStory(s, facts).reasons
    .filter(r => /coordinator|facts|class is signed|unverified/i.test(r));
  pts += Math.max(0, 20 - factConflicts.length * 10);
  reasons.push(...factConflicts.map(r => `facts: ${r}`));

  // Completeness — 10 (covers both story schemas)
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
  pts += Math.round((present / fields.length) * 10);
  if (present < fields.length) reasons.push(`completeness: ${present}/${fields.length} sections filled`);

  // Substance — 25, with hard caps: hollow or self-repeating stories can
  // never score above 50 no matter how well-formed the JSON is
  const sub = substanceScore(s);
  pts += sub.pts;
  reasons.push(...sub.reasons);

  return { score: Math.min(clamp(pts), sub.cap), reasons };
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
