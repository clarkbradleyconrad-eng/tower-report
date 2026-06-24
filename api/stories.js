/**
 * Tower Report — /api/stories
 *
 * Uses Grok 4 with live web search to surface, analyze, and rank
 * the most important Texas Longhorns football stories in real time.
 *
 * Env vars:
 *   XAI_API_KEY  — xAI API key (same one used by /api/chat)
 *
 * Cache: Vercel edge caches for 15 min; stale-while-revalidate for 30 min
 * so users get fresh intel without waiting on cold calls.
 */

export const config = { runtime: 'edge' };

const SYSTEM = `You are Tower AI — the intelligence engine for Tower Report, the premier Texas Longhorns football analysis platform.

Search the web RIGHT NOW and find the most current, important Texas Longhorns football news from the past 7 days. Then analyze, rank, and format each story for Longhorn fans who demand more than headlines.

Return ONLY a valid JSON object — no markdown fences, no text outside the JSON:

{
  "lastUpdated": "<ISO 8601 timestamp>",
  "totalSignals": <integer between 800 and 1400>,
  "stories": [
    {
      "id": 1,
      "rank": 1,
      "headline": "<specific, compelling, fact-based headline>",
      "category": "<exactly one of: Program Outlook | QB & Offense | Roster & Portal | Defense & Stars | Recruiting | Coaching | Game Recap>",
      "impact": <integer 70-99>,
      "trending": <true or false>,
      "date": "<Month D, YYYY>",
      "hook": "<2-3 sentences: the key fact + why Longhorn fans should care RIGHT NOW>",
      "tags": ["<tag1>", "<tag2>", "<tag3>"],
      "players": ["<First Last>"],
      "overview": "<Full analysis. Use this exact structure: 'What happened: [text]<br><br><strong>Why it matters:</strong> [text]<br><br><strong>What to watch next:</strong> [text]'. Do not use any other HTML tags.>",
      "relatedImpact": "<1 sentence connecting this story to the 2026 championship path>",
      "sources": ["<Publication Name 1>", "<Publication Name 2>"]
    }
  ]
}

Tower AI Ranking Methodology — score every story by this weighted model:
- 40%: Program & Roster Impact — direct effect on 2026 wins, CFP odds, depth chart changes, or championship trajectory
- 25%: Fan & Social Velocity — real-time volume and sentiment on X, Longhorn forums, 247Sports, insider circles
- 20%: Recruiting & Portal Momentum — class rankings, commitments, flips, decommits, visits, portal entries/exits
- 15%: Expert & Media Consensus — 247Sports Crystal Balls, ESPN/On3 analysis, Vegas lines, analyst alignment

Priority topics (cover as many as relevant):
Arch Manning health and performance, transfer portal activity (entries and commitments), Steve Sarkisian quotes/decisions, recruiting news (commits, visits, decommits), player injuries or returns, upcoming schedule implications (especially Ohio State Week 2), CFP outlook, NIL developments, Will Muschamp defense construction, depth chart battles.

Rules:
- Rank #1 = highest impact. Do not rank by date.
- Return between 6 and 10 stories.
- Every story must be grounded in real news you found via search.
- No text, no explanation, no markdown — just the JSON object.`;

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'API not configured', code: 'NO_KEY' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const xaiRes = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-4',
        instructions: SYSTEM,
        input: [
          {
            role: 'user',
            content: `Today is ${today}. Search the web and return 6-10 Texas Longhorns football stories from the past 7 days, ranked by the Tower AI methodology. Return only the JSON object — nothing else.`,
          },
        ],
        tools: [{ type: 'web_search' }],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!xaiRes.ok) {
      const errBody = await xaiRes.text().catch(() => '');
      console.error('[tower/stories] xAI error', xaiRes.status, errBody.slice(0, 300));
      return new Response(
        JSON.stringify({ error: 'Upstream API error', code: 'XAI_ERROR' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data = await xaiRes.json();
    const messageItem = data.output?.find(o => o.type === 'message');
    const content = messageItem?.content?.find(c => c.type === 'output_text')?.text;

    if (!content) throw new Error('Empty response from Grok');

    const stories = JSON.parse(content);

    if (!stories.stories || !Array.isArray(stories.stories) || stories.stories.length === 0) {
      throw new Error('Invalid stories payload from Grok');
    }

    return new Response(JSON.stringify(stories), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        // 15-minute edge cache; stale-while-revalidate for 30 min
        'Cache-Control': 's-maxage=900, stale-while-revalidate=1800',
      },
    });

  } catch (err) {
    console.error('[tower/stories] handler error:', err.message);
    return new Response(
      JSON.stringify({ error: 'Internal error', message: err.message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
