/**
 * Tower Report bots — prompt loading + versioning
 *
 * Every Grok system prompt lives in bots/prompts/{botId}.md. The loader
 * substitutes {{TOKENS}} and returns a sha256 hash of the RAW file, so every
 * output can be traced to the exact prompt revision via git history
 * (`git log -p bots/prompts/{botId}.md`).
 *
 * Standard tokens injected for every bot:
 *   {{FACTS}}          — hand-verified program facts block from data/facts.json
 *   {{SOURCING_RULES}} — shared sourcing standards (api/_lib/story-standards.js)
 *   {{GRAPHICS_RULES}} — shared impactBreakdown/seasonModel standards
 *   {{TODAY}}          — human-readable current date
 */

import { createHash } from 'node:crypto';
import { readRepoText, readRepoJson } from './repo.js';
import { factsPromptBlock, SOURCING_RULES, GRAPHICS_RULES } from '../../api/_lib/story-standards.js';

export async function loadFacts() {
  return readRepoJson('data/facts.json');
}

/** Build the standard token map. Pass preloaded facts to avoid a second read. */
export async function standardVars(facts) {
  const f = facts !== undefined ? facts : await loadFacts();
  return {
    FACTS: factsPromptBlock(f),
    SOURCING_RULES,
    GRAPHICS_RULES,
    TODAY: new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    }),
  };
}

/**
 * Load bots/prompts/{botId}.md, substitute tokens, return { text, hash }.
 * hash identifies the raw prompt file content (12 hex chars of sha256).
 */
export async function loadPrompt(botId, vars = {}) {
  const raw = await readRepoText(`bots/prompts/${botId}.md`);
  if (raw == null) throw new Error(`Prompt file missing: bots/prompts/${botId}.md`);
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  let text = raw;
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`{{${k}}}`).join(v == null ? '' : String(v));
  }
  // Unresolved tokens must never reach the model
  text = text.replace(/\{\{[A-Za-z0-9_:-]+\}\}/g, '').trim();
  return { text, hash };
}

/** Convenience: prompt with the standard facts/rules tokens already applied. */
export async function loadPromptWithFacts(botId, facts, extraVars = {}) {
  const vars = { ...(await standardVars(facts)), ...extraVars };
  return loadPrompt(botId, vars);
}

/**
 * Robust JSON extraction for Grok responses: strips markdown fences and
 * pulls the outermost {...} or [...] before parsing.
 */
export function parseModelJson(content) {
  let text = String(content || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  const first = text.search(/[[{]/);
  if (first === -1) throw new Error('No JSON in model response');
  const open = text[first];
  const close = open === '{' ? '}' : ']';
  const last = text.lastIndexOf(close);
  if (last <= first) throw new Error('Unbalanced JSON in model response');
  return JSON.parse(text.slice(first, last + 1));
}
