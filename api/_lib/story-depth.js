/**
 * Tower Report — depth repair pass
 *
 * When a generated story fails validateStory on ONLY depth reasons (sections
 * under their word floors), the research in it is sound — the model just
 * wrote short. Instead of discarding the story (and the paid web-search run
 * that produced it), send it back to Grok WITHOUT web search and have the
 * flagged sections expanded to their full budgets using only material
 * already in the draft. The caller re-validates the result; a story that is
 * still shallow after one repair is rejected as before.
 *
 * Used by /api/stories-refresh and /api/generate-story.
 */

import { parseModelJson } from '../../bots/lib/prompts.js';

/** True when every rejection reason is a depth-gate shortfall. */
export function isDepthOnlyRejection(reasons) {
  return Array.isArray(reasons) && reasons.length > 0
    && reasons.every(r => /^depth:/.test(String(r)));
}

const REPAIR_INSTRUCTIONS = `You are Tower Report's senior editor. A story draft below failed the automated depth gate: the flagged sections are too short. Your ONLY job is to expand the flagged sections to their full word budgets. This is an expansion edit, not a rewrite.

HARD RULES — violations get the story rejected a second time:
1. NEVER add a fact, statistic, date, ranking, dollar figure, quote, or player/coach name that is not already in the draft. You have no web access — new "facts" would be fabrications.
2. Expand with ANALYSIS of the facts already present: second-order effect chains (who moves, whose snaps shift, what scholarship frees up), snap/rotation/two-deep math, the mechanical application against opponents the draft already names, structural historical patterns, the contrarian read on the consensus, and falsifiable predictions with approximate dates.
3. Every added sentence must teach a serious fan something — no padding, no restating a point already made, no filler transitions.
4. Keep every NON-flagged field byte-for-byte identical: same headline/title, same players, sources, tags, categories, impact score, impactBreakdown, seasonModel, same JSON shape.
5. Word budgets to hit (only for sections that exist in this draft):
   - footballImpact / impactOnTexas: 260-360 words — the centerpiece. Scheme mechanics, roster math, opponent application, precedent.
   - whatHappened: 130-220 words. whyItMatters: 110-170 words.
   - whatChanges: 90-140 words. towerTake / futureOutlook: 90-140 words.
   - whoItAffects (if present): 4-6 entries, 2 sentences each.
6. Return ONLY the complete corrected story JSON object — the same shape you received, no wrapper object, no markdown fences, no commentary.`;

/**
 * One repair attempt. Returns the expanded story object (same shape).
 * Throws on API/parse failure — callers treat that as "repair unavailable"
 * and fall back to the normal rejection path.
 */
export async function repairStoryDepth(story, reasons, { timeoutMs = 45000 } = {}) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');

  const userMessage =
    `DEPTH GATE FAILURES to fix:\n${reasons.map(r => `- ${r}`).join('\n')}\n\n` +
    `STORY DRAFT (expand the flagged sections, keep everything else identical):\n` +
    JSON.stringify(story, null, 2);

  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4',
      instructions: REPAIR_INSTRUCTIONS,
      input: [{ role: 'user', content: userMessage }],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`xAI repair error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const messageItem = data.output?.find(o => o.type === 'message');
  const content = messageItem?.content?.find(c => c.type === 'output_text')?.text;
  if (!content) throw new Error('Empty repair response from Grok');

  const fixed = parseModelJson(content);
  if (!fixed || typeof fixed !== 'object') throw new Error('Repair returned non-object');
  // Model sometimes re-wraps in the generator schema; unwrap it
  return fixed.story && typeof fixed.story === 'object' ? fixed.story : fixed;
}
