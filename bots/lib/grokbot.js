/**
 * Tower Report bots — generic Grok bot runner
 *
 * Runs any registry bot with kind:"grok" from config alone: system prompt
 * from bots/prompts/{id}.md, named inputs resolved and appended to the user
 * message, JSON output parsed (with one strict retry), quality-scored, and
 * written to the blob named in the bot's outputs. No per-bot code.
 *
 * Rejection: scores under REJECT_THRESHOLD are never published — they go to
 * the per-bot rejection queue for review on ops.html, and the previous
 * output blob stays in place.
 */

import { loadPromptWithFacts, parseModelJson } from './prompts.js';
import { scoreOutput, REJECT_THRESHOLD } from './score.js';
import { blobGetJson, blobPutJson, pushRejected, KEYS } from './blob.js';

/* Named input providers available to grok bots via registry "inputs".
   (data/facts.json is always injected into the prompt itself via {{FACTS}}.) */
const INPUT_PROVIDERS = {
  // The day's top published story: highest impact of the last 36h,
  // falling back to the newest archive entries.
  topStory: async () => {
    const archive = (await blobGetJson(KEYS.stories.prefix)) || [];
    if (!Array.isArray(archive) || !archive.length) return null;
    const cutoff = Date.now() - 36 * 3600 * 1000;
    const recent = archive.filter(s => new Date(s._generated || s.date || 0).getTime() >= cutoff);
    const pool = recent.length ? recent : archive.slice(0, 5);
    const top = [...pool].sort((a, b) => (Number(b.impact) || 0) - (Number(a.impact) || 0))[0];
    if (!top) return null;
    return {
      id: top.id,
      headline: top.headline,
      hook: top.hook,
      whatHappened: top.whatHappened,
      whyItMatters: top.whyItMatters,
      footballImpact: top.footballImpact,
      towerTake: top.towerTake,
      players: top.players,
      sources: top.sources,
      impact: top.impact,
    };
  },
};

function outputBlob(bot) {
  const spec = (bot.outputs || []).find(o => String(o).startsWith('blob:'));
  if (!spec) return null;
  const path = spec.slice(5).split(' ')[0];
  return { path, prefix: path.replace(/\.json$/, '') };
}

async function callGrok(system, userMessage, { webSearch, timeoutMs }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4',
      instructions: system,
      input: [{ role: 'user', content: userMessage }],
      ...(webSearch ? { tools: [{ type: 'web_search' }] } : {}),
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`xAI error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const messageItem = data.output?.find(o => o.type === 'message');
  const content = messageItem?.content?.find(c => c.type === 'output_text')?.text;
  if (!content) throw new Error('Empty response from Grok');
  return content;
}

/**
 * Run one kind:"grok" bot. Returns { summary, score, promptHash, rejected }.
 * Throws on hard failure (missing input, model/API failure) — the
 * orchestrator catches and isolates it.
 */
export async function runGrokBot(bot, { facts, dryRun } = {}) {
  const { text: system, hash: promptHash } = await loadPromptWithFacts(bot.id, facts);

  const inputBlocks = [];
  for (const name of bot.inputs || []) {
    const provider = INPUT_PROVIDERS[name];
    if (!provider) continue; // data/*.json entries are documentation, not providers
    const value = await provider();
    if (value == null) throw new Error(`Input "${name}" unavailable (no data yet)`);
    inputBlocks.push(`INPUT ${name}:\n${JSON.stringify(value, null, 2)}`);
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const userMessage = `Today is ${today}.\n\n${inputBlocks.join('\n\n')}\n\nFollow your instructions and return ONLY the JSON object.`;

  const grokTimeout = Math.max(15000, (bot.timeoutMs || 60000) - 5000);
  let parsed;
  try {
    parsed = parseModelJson(await callGrok(system, userMessage, { webSearch: !!bot.webSearch, timeoutMs: grokTimeout }));
  } catch (err) {
    // One strict retry — malformed JSON is the dominant transient failure
    const retryMsg = `${userMessage}\n\nREMINDER: your previous response was not valid JSON (${String(err.message).slice(0, 100)}). Return ONLY the raw JSON object — no markdown fences, no commentary.`;
    parsed = parseModelJson(await callGrok(system, retryMsg, { webSearch: !!bot.webSearch, timeoutMs: grokTimeout }));
  }

  const scoreable = bot.outputType === 'social' ? parsed.drafts : parsed;
  const { score, reasons } = scoreOutput(bot.outputType, scoreable, { facts });

  if (score != null && score < REJECT_THRESHOLD) {
    if (!dryRun) {
      await pushRejected(bot.id, { promptHash, score, reasons, output: parsed });
    }
    return {
      rejected: true, score, promptHash,
      summary: { rejected: true, reasons: reasons.slice(0, 5) },
    };
  }

  const target = outputBlob(bot);
  if (target && !dryRun) {
    await blobPutJson(target.path, target.prefix, {
      updatedAt: new Date().toISOString(),
      botId: bot.id,
      promptHash,
      score,
      ...parsed,
    });
  }

  const summary = bot.outputType === 'social'
    ? { drafts: (parsed.drafts || []).length, storyHeadline: parsed.storyHeadline }
    : { keys: Object.keys(parsed).slice(0, 6) };
  return { rejected: false, score, promptHash, summary: { ...summary, ...(dryRun ? { dryRun: true } : {}) } };
}
