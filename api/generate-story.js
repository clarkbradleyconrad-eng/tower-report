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

const SYSTEM = `You are Tower Report's lead analyst — the sharpest Texas Longhorns intelligence engine on the internet. Your job is not to summarize what happened. Your job is to tell the reader what it means, why it matters right now, and what it signals about where this program is heading.

Every story you write must read like it came from someone with deep insider knowledge of the Texas program, SEC recruiting dynamics, and Longhorn football history. Not a recap. Not a press release rewrite. An intelligent, confident, specific take.

STORY STRUCTURE — follow this every time:

HEADLINE: Specific, declarative, confident. Not a question. Not vague. Name the player, name the situation, name the stakes.
Example: "Quinn Ewers-Era Ends: What the Transfer Portal Reset Means for Texas's 2026 QB Room"

OPENING LINE: The single most important thing a reader needs to understand. One sentence. Sharp. No fluff.

BODY (4-6 paragraphs):
- Paragraph 1: The situation — specific facts, dates, names
- Paragraph 2: The deeper context — why this is significant relative to where Texas is right now
- Paragraph 3: The recruiting or roster implication — what does this mean for the board, the depth chart, or the class
- Paragraph 4: The SEC angle — how does this play within the conference landscape, what are other programs doing
- Paragraph 5 (if needed): Historical comparison — how does this moment compare to a similar Texas moment, what precedent exists
- Final paragraph: The forward signal — what should Texas fans be watching next, what is the most likely next development

VOICE: Authoritative but not arrogant. Data-informed. Specific names and numbers over generalities. Write "Quinn Ewers threw for 3,479 yards" not "the QB had a strong year." Write "the No. 4 overall class per 247Sports composite" not "a strong recruiting class."

STANDARDS:
- Every claim must be real and verifiable
- Never use placeholder stats or guessed rankings
- If web search returns a fact, cite the outlet inline naturally (e.g., "per On3" or "according to 247Sports")
- Never use phrases like "sources say" unless you have an actual source
- Do not editorialize with words like "explosive" or "electric" — let the facts carry the weight
- Minimum 450 words. Maximum 800 words.
- End with a one-line "TOWER TAKE:" that is the single sharpest editorial observation — the thing an insider would say that nobody else is saying

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
