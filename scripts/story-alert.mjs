#!/usr/bin/env node
/**
 * Tower Report — story alert on publish.
 * Called by .github/workflows/story-alert.yml when the orchestrator dispatches
 * a 'story-published' repository_dispatch event.
 *
 * Reads the event payload from STORY_EVENT env var (JSON string), formats
 * the alert, and sends via notify.mjs.
 *
 * Payload shape (from orchestrator dispatchStoryAlert):
 *   storyHeadline, storyUrl, category, impact, hook, whyItMatters,
 *   players, sources, drafts (social-drafter output), added, total
 */

import { send } from './notify.mjs';

const SITE = 'https://tower-report.vercel.app';

async function main() {
  const raw = process.env.STORY_EVENT;
  if (!raw) throw new Error('STORY_EVENT env var not set');

  let ev;
  try {
    ev = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse STORY_EVENT JSON: ${err.message}`);
  }

  const msg = buildAlert(ev);
  await send(msg);
  console.log(`Story alert sent: ${msg.title}`);
}

function buildAlert(ev) {
  const headline  = ev.storyHeadline || 'New story published';
  const score     = ev.impact != null ? ev.impact : null;
  const category  = ev.category ? String(ev.category).toUpperCase() : 'STORY';
  const url       = ev.storyUrl || `${SITE}/stories.html`;
  const scoreLabel = score != null ? `Quality ${score}/100` : '';

  const lines = [];

  // Header
  lines.push(`${category}${scoreLabel ? ` · ${scoreLabel}` : ''}`);
  lines.push(headline);
  lines.push('');

  // 2-sentence summary from hook
  const summary = ev.hook || ev.whyItMatters || '';
  if (summary) {
    const sentences = summary.match(/[^.!?]+[.!?]+/g) || [summary];
    lines.push(sentences.slice(0, 2).join(' ').trim());
    lines.push('');
  }

  // Live link
  lines.push(url);
  lines.push('');

  // X posts
  const drafts = ev.drafts;
  if (Array.isArray(drafts) && drafts.length > 0) {
    lines.push('─── X POSTS ───');
    drafts.forEach((d, i) => {
      const label = d.type || d.style || `post ${i + 1}`;
      // Replace [link] placeholder with the actual story URL
      const text = String(d.text || '').replace('[link]', url);
      const chars = text.length;
      const warn  = chars > 270 ? ` ⚠️ ${chars} chars` : '';
      lines.push('');
      lines.push(`${i + 1}. ${label.toUpperCase()}${warn}`);
      lines.push(text);
    });
  } else {
    lines.push('(X drafts not available this run — check ops.html)');
  }

  // Instagram caption
  if (ev.drafts?.instagram || (drafts && drafts[0]?.instagram)) {
    lines.push('');
    lines.push('─── INSTAGRAM ───');
    lines.push(ev.drafts?.instagram || drafts[0]?.instagram || '');
  }

  // Thread (90+ impact stories)
  const thread = ev.drafts?.thread || (Array.isArray(ev.thread) ? ev.thread : null);
  if (Array.isArray(thread) && thread.length > 0) {
    lines.push('');
    lines.push(`─── THREAD (${score}+ impact) ───`);
    thread.forEach((post, i) => {
      const text = String(post).replace('[link]', url);
      lines.push('');
      lines.push(`${i + 1}/${thread.length} ${text}`);
    });
  }

  const body = lines.join('\n');

  // SMS: headline + first X post + link (no article body)
  const firstPost = Array.isArray(drafts) && drafts[0]
    ? String(drafts[0].text || '').replace('[link]', url)
    : url;
  const smsBody = `${headline}\n\n${firstPost}`;

  return {
    title: `NEW STORY — ${headline.slice(0, 65)}`,
    body,
    urgency: score != null && score >= 90 ? 'high' : 'normal',
    smsBody,
  };
}

main().catch(err => { console.error(err); process.exit(1); });
