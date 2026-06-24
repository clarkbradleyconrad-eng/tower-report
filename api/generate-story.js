/**
 * Tower Report — /api/generate-story
 *
 * Newsroom AI story generator. Takes a topic/event and produces a full
 * Tower Report article + four Twitter/X drafts using Grok with live search.
 *
 * POST body: { eventType, topic, sourceContent?, sourceUrl? }
 * Returns:   { story: {...}, socialPosts: { breaking, analysis, engagement, readMore } }
 *
 * Env vars:
 *   XAI_API_KEY — xAI API key
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM = `You are Tower AI — the editorial engine for Tower Report, the premier Texas Longhorns football intelligence platform.

Your job is to research and write a complete, publication-ready Tower Report article. Search the web for the latest facts, then write with the authority of an insider who has seen every game and knows every recruit.

Tower Report editorial voice:
- Direct and confident. No hedging, no "reportedly" unless truly unconfirmed.
- Specific over general. Player names, positions, classes, rankings.
- Always connect news to Texas's 2026 CFP trajectory.
- Longhorn-fan perspective: honest about challenges, bullish on the program's ceiling.

Return ONLY a valid JSON object in this exact shape — no markdown, no explanation:

{
  "story": {
    "kicker": "<SHORT LABEL IN CAPS — e.g. RECRUITING · COMMITMENT or BREAKING · TRANSFER>",
    "title": "<Compelling, specific headline — no clickbait, just facts that hook>",
    "summary": "<2-3 sentences: the key fact + why Longhorn fans need to know this RIGHT NOW>",
    "whatHappened": "<3-5 paragraphs of factual reporting. What exactly happened, when, who's involved, key details>",
    "whyItMatters": "<2-4 paragraphs: the deeper football and recruiting implications>",
    "impactOnTexas": "<2-3 paragraphs: specific effect on the 2026 roster, depth chart, or recruiting trajectory>",
    "futureOutlook": "<1-2 paragraphs: what to watch next, next measurable milestones>",
    "keySignals": ["<signal 1 — one sharp analytical observation>", "<signal 2>", "<signal 3>", "<signal 4>", "<signal 5>"],
    "categories": ["<one of: Analysis | Recruiting | Portal | Offense | Defense | Championship | Program | Rivalry | Film Room | Depth Chart>"],
    "tags": ["<tag1>", "<tag2>", "<tag3>"],
    "impactScore": <integer 60-99, honest assessment of this story's importance to the 2026 season>
  },
  "socialPosts": {
    "breaking": "<Under 280 chars. Breaking alert style. Lead with the news, end with #HookEm>",
    "analysis": "<Under 280 chars. Your analytical take on what it means. Include a stat or specific detail>",
    "engagement": "<Under 280 chars. Question to fans — get them debating. End with #HookEm>",
    "readMore": "<Under 280 chars. Story share format. Tease the angle. Link placeholder: https://tower-report.vercel.app/stories.html>"
  }
}`;

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'XAI_API_KEY not configured' }),
      { status: 503, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const { eventType, topic, sourceContent, sourceUrl } = body;

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  let userPrompt = `Today is ${today}.\n\nEvent type: ${eventType || 'Program News'}\n\n`;
  if (topic) userPrompt += `Story topic: ${topic}\n\n`;
  if (sourceContent) userPrompt += `Source content (use this as the factual foundation):\n${sourceContent}\n\n`;
  if (sourceUrl) userPrompt += `Source URL: ${sourceUrl}\n\n`;
  userPrompt += 'Search the web for the latest information on this topic. Write the full Tower Report article and return only the JSON object.';

  try {
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
          { role: 'user', content: userPrompt },
        ],
        tools: [{ type: 'web_search' }],
        temperature: 0.25,
      }),
      signal: AbortSignal.timeout(55000),
    });

    if (!xaiRes.ok) {
      const errText = await xaiRes.text().catch(() => '');
      console.error('[tower/generate-story] xAI error', xaiRes.status, errText.slice(0, 300));
      return new Response(
        JSON.stringify({ error: 'AI generation failed', code: 'XAI_ERROR' }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const data = await xaiRes.json();
    const messageItem = data.output?.find(o => o.type === 'message');
    const content = messageItem?.content?.find(c => c.type === 'output_text')?.text;
    if (!content) throw new Error('Empty response from Grok');

    const parsed = JSON.parse(content);
    if (!parsed.story?.title) throw new Error('Invalid story payload');

    const id = `story-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const story = {
      ...parsed.story,
      id,
      status: 'draft',
      createdAt: new Date().toISOString(),
      publishedAt: null,
      url: null,
      source: 'Tower Report',
      depthLevel: 'deep',
      isStoryOfTheDay: false,
      imageUrl: null,
      readTime: Math.max(2, Math.round((
        (parsed.story.whatHappened || '').length +
        (parsed.story.whyItMatters || '').length +
        (parsed.story.impactOnTexas || '').length
      ) / 1200)),
    };

    return new Response(JSON.stringify({ story, socialPosts: parsed.socialPosts || {} }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[tower/generate-story]', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
}
