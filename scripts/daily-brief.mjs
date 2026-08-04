#!/usr/bin/env node
/**
 * Tower Report — 07:00 CT daily brief.
 * Fetches /api/health + /api/briefing, formats a ~400-word digest, sends via notify.mjs.
 * Called by .github/workflows/daily-brief.yml.
 *
 * Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (or NOTIFY_CHANNEL override)
 */

import { send } from './notify.mjs';

const BASE = 'https://tower-report.vercel.app';
const SITE = 'tower-report.vercel.app';

async function main() {
  const [healthResult, briefingResult] = await Promise.allSettled([
    fetchJson(`${BASE}/api/health`),
    fetchJson(`${BASE}/api/briefing`),
  ]);

  const h = healthResult.status === 'fulfilled' ? healthResult.value : null;
  const b = briefingResult.status === 'fulfilled' ? briefingResult.value : null;

  if (!h) {
    await send({
      title: 'TOWER REPORT — HEALTH CHECK FAILED',
      body: `Could not reach ${BASE}/api/health. Site may be down.\n\n${SITE}`,
      urgency: 'high',
      smsBody: `TOWER REPORT: Health check failed. Check ${SITE}`,
    });
    return;
  }

  const msg = buildBrief(h, b);
  await send(msg);
  console.log(`Sent: ${msg.title}`);
}

function buildBrief(h, b) {
  const run    = h.latestRun;
  const steps  = run?.steps || [];
  const quality = h.quality || {};
  const briefItems = b?.briefing || [];

  const failed    = steps.filter(s => !s.ok);
  const credFails = failed.filter(s => (s.error || '').includes('not configured'));
  const hardFails = failed.filter(s => !(s.error || '').includes('not configured'));

  const issueCount = hardFails.length + (credFails.length ? 1 : 0);
  const verdict = hardFails.length > 0
    ? 'TOWER REPORT — ACTION REQUIRED'
    : issueCount > 0
      ? `TOWER REPORT — ${issueCount} issue${issueCount > 1 ? 's' : ''}`
      : 'TOWER REPORT — All clear';

  const lines = [];

  // ── 1. Trust ──────────────────────────────────────────────────────────────
  const rejects = quality.rejectedDetail || [];
  const accuracyRejects = rejects.filter(r =>
    /fact|accuracy|contradict|verify|inaccurate/i.test(r.reason || '')
  );
  lines.push('TRUST');
  if (accuracyRejects.length > 0) {
    lines.push(`⚠️ ${accuracyRejects.length} story rejected for accuracy:`);
    accuracyRejects.forEach(r =>
      lines.push(`  "${r.headline || '(untitled)'}" — ${r.reason}`)
    );
  } else {
    const refreshOk = steps.find(s => s.name === 'stories-refresh')?.ok;
    lines.push(refreshOk
      ? 'Truth guard passed. No accuracy issues.'
      : 'stories-refresh did not run — accuracy unverified.'
    );
  }

  // ── 2. Traffic ────────────────────────────────────────────────────────────
  lines.push('');
  lines.push('TRAFFIC');
  lines.push('Not yet enabled. Turn on: Vercel Dashboard → Analytics → Enable Web Analytics.');

  // ── 3. What shipped ───────────────────────────────────────────────────────
  const added    = quality.storiesAdded ?? 0;
  const dupes    = quality.duplicatesDropped ?? 0;
  const rejected = quality.storiesRejected ?? 0;
  const total    = steps.find(s => s.name === 'stories-refresh')?.detail?.total;
  const draft    = steps.find(s => s.name === 'generate-story');

  lines.push('');
  lines.push('WHAT SHIPPED');
  lines.push(`${added} stor${added !== 1 ? 'ies' : 'y'} published${total ? ` (archive: ${total} total)` : ''}`);
  if (dupes > 0)    lines.push(`${dupes} duplicate${dupes !== 1 ? 's' : ''} dropped`);
  if (rejected > 0) lines.push(`${rejected} rejected — ${rejects.map(r => r.reason || '?').join('; ')}`);
  if (draft?.ok && draft.detail?.title) {
    lines.push(`Draft: "${draft.detail.title}"`);
  }

  // ── 4. System ─────────────────────────────────────────────────────────────
  lines.push('');
  lines.push('SYSTEM');
  lines.push(`Last run: ${formatCT(h.lastRun)} CT (${(h.hoursSinceLastRun ?? 0).toFixed(1)}h ago, ${run?.trigger ?? '?'})`);

  const okNames = steps.filter(s => s.ok).map(s => s.name);
  if (okNames.length) lines.push(`OK: ${okNames.join(', ')}`);
  hardFails.forEach(s =>
    lines.push(`FAILED: ${s.name} — ${(s.error || '').slice(0, 80)}`)
  );
  if (credFails.length > 0) {
    lines.push(`Creds missing: ${credFails.map(s => s.name).join(', ')}`);
  }

  // ── 5. Needs me ───────────────────────────────────────────────────────────
  lines.push('');
  lines.push('NEEDS YOU');
  const actions = [];
  hardFails.forEach(s => actions.push(`Fix ${s.name}: ${(s.error || '').slice(0, 70)}`));
  if (credFails.length > 0) {
    const missing = [...new Set(
      credFails.flatMap(s => {
        const m = (s.error || '').match(/"missing":\[([^\]]+)\]/);
        return m ? m[1].replace(/"/g, '').split(',') : [s.name];
      })
    )];
    actions.push(`Add to Vercel env: ${missing.join(', ')}`);
  }
  lines.push(actions.length === 0 ? 'Nothing.' : actions.map(a => `• ${a}`).join('\n'));

  // ── 6. Today's move ───────────────────────────────────────────────────────
  lines.push('');
  lines.push("TODAY'S MOVE");
  const top = briefItems.find(i => i.importance === 'HIGH') || briefItems[0];
  if (top) {
    lines.push(top.headline);
    if (top.whyItMatters) lines.push(`→ ${top.whyItMatters}`);
  } else {
    lines.push(`Review the briefing at ${SITE}`);
  }

  lines.push('');
  lines.push(SITE);

  const smsBody = [
    `${added} stor${added !== 1 ? 'ies' : 'y'} published.`,
    hardFails.length > 0 ? `${hardFails.length} FAILURE(S) — check ops.` : `${okNames.length} bots OK.`,
    SITE,
  ].join(' ');

  return {
    title: verdict,
    body: lines.join('\n'),
    urgency: hardFails.length > 0 ? 'high' : 'normal',
    smsBody,
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function formatCT(iso) {
  if (!iso) return 'unknown';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}

main().catch(err => { console.error(err); process.exit(1); });
