/**
 * Tower Report bots — alerts bot (runs last in every orchestrator cycle)
 *
 * Posts to Slack (env SLACK_OPS_WEBHOOK) when:
 *   - any bot failed this run (bot alert.onFail)
 *   - a bot's quality score dropped more than alert.qualityDrop (default 15)
 *     below its rolling 30-day average
 *   - the watchdog found no run fired by 10:00 UTC (watchdogMiss)
 *   - the review queue (rejected outputs + NEEDS-VERIFICATION items) exceeds 10
 *
 * With no webhook configured it still evaluates and returns what it WOULD
 * have sent, so the run log shows alert coverage either way.
 */

const OPS_URL = 'https://tower-report.vercel.app/ops.html';

/** 30-day average score for a bot from tower-bot-stats entries, excluding the current run. */
function rollingAvg(statEntries) {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const scores = (statEntries || [])
    .filter(e => e.score != null && new Date(e.t).getTime() >= cutoff)
    .map(e => e.score);
  if (!scores.length) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Evaluate alert conditions.
 * ctx: {
 *   results: [{ id, name, ok, skipped, error, score, alert }],
 *   stats:   { <botId>: [{ t, score, ok, ms, promptHash }] }  (BEFORE this run),
 *   reviewQueueSize: number,
 *   watchdogMiss: { lastRun } | null,
 * }
 */
export function evaluateAlerts(ctx) {
  const alerts = [];

  for (const r of ctx.results || []) {
    if (r.skipped) continue;
    if (!r.ok && r.alert?.onFail !== false) {
      alerts.push({
        bot: r.name || r.id,
        what: 'run failed',
        detail: String(r.error || 'unknown error').slice(0, 140),
      });
    }
    const dropLimit = r.alert?.qualityDrop ?? 15;
    if (r.ok && r.score != null) {
      const avg = rollingAvg(ctx.stats?.[r.id]);
      if (avg != null && r.score <= avg - dropLimit) {
        alerts.push({
          bot: r.name || r.id,
          what: 'quality drop',
          detail: `scored ${r.score}, 30-day avg ${avg.toFixed(1)} (drop > ${dropLimit})`,
        });
      }
    }
  }

  if (ctx.watchdogMiss) {
    alerts.push({
      bot: 'orchestrator',
      what: 'no run fired by 10:00 UTC',
      detail: `last run: ${ctx.watchdogMiss.lastRun || 'never'}`,
    });
  }

  if ((ctx.reviewQueueSize || 0) > 10) {
    alerts.push({
      bot: 'review queue',
      what: 'queue exceeds 10 items',
      detail: `${ctx.reviewQueueSize} rejected/unverified items awaiting review`,
    });
  }

  return alerts;
}

export async function postToSlack(alerts) {
  const webhook = process.env.SLACK_OPS_WEBHOOK;
  if (!webhook) return { posted: false, reason: 'SLACK_OPS_WEBHOOK not set' };
  if (!alerts.length) return { posted: false, reason: 'nothing to report' };

  const lines = alerts.map(a => `• *${a.bot}* — ${a.what}: ${a.detail}`);
  const payload = {
    text: `Tower Report bots: ${alerts.length} alert${alerts.length > 1 ? 's' : ''}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:rotating_light: *Tower Report bot alerts*\n${lines.join('\n')}` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `<${OPS_URL}|Open the ops dashboard>` }],
      },
    ],
  };
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}`);
  return { posted: true };
}

/** Full alerts-bot run. dryRun evaluates but never posts. */
export async function runAlertsBot(ctx, { dryRun } = {}) {
  const alerts = evaluateAlerts(ctx);
  if (dryRun) return { summary: { alerts: alerts.length, dryRun: true, wouldSend: alerts } };
  const result = await postToSlack(alerts);
  return { summary: { alerts: alerts.length, ...result, items: alerts } };
}
