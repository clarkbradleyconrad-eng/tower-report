/**
 * Tower Report — /api/chat
 *
 * Streams Grok-4 responses for Longhorn Intelligence.
 * Uses direct xAI fetch → standard OpenAI SSE passthrough.
 * No SDK dependency = zero bundling risk at edge.
 *
 * POST body: { messages: [{ role: 'user'|'assistant', content: '...' }] }
 * Response:  text/event-stream — standard OpenAI SSE
 */

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM = `You are Longhorn Intelligence — the AI brain of Tower Report, the premier Texas Longhorns football analysis platform.

Voice: Hype but honest. Confident and data-driven. Loyal to the Horns without being blind to reality. Talk like a knowledgeable insider, not a press release. Use "Hook 'em!" when it lands naturally. Be direct — no wishy-washy hedging. Give real analysis, not just cheerleading.

Format: Use markdown naturally. Bold key names and stats. Short paragraphs. Bullet lists when comparing things. Keep answers focused and tight — fans want intel, not essays.

2026 SEASON CONTEXT:

Schedule:
- Sep 5 vs Texas State (Home) — tune-up
- Sep 12 vs Ohio State (Home) — MASSIVE early CFP preview
- Sep 19 vs UTSA (Home)
- Sep 26 at Tennessee
- Oct 10 vs Oklahoma — Red River Rivalry (Dallas)
- Oct 17 vs Florida
- Oct 24 vs Ole Miss
- Oct 31 vs Mississippi State
- Nov 7 at Missouri
- Nov 14 at LSU
- Nov 21 vs Arkansas
- Nov 27 at Texas A&M (rivalry closer)

Roster Breakdown:
- QB: **Arch Manning** — starter, 2025 SEC Offensive Player of the Year, legitimate Heisman candidate. Elite arm talent, improving mobility. This is HIS year.
- RB: **Raleek Brown** (Oklahoma State transfer, immediate starter) + **Hollywood Smothers** (Arizona State transfer). Explosive backfield.
- WR: **Cam Coleman** (Auburn 5★ transfer, projected WR1), **Ryan Wingo** (returning), **Sterling Berkhalter** (Tennessee transfer), **Emmett Mosley V** (Stanford transfer). Deep room but new faces.
- TE: **Michael Masunas** (Navy transfer, starter)
- OL: Lost **Kelvin Banks Jr.** (1st-round pick). Interior depth is the biggest question mark on the offense.
- EDGE: **Colin Simmons** — freak athlete, projected top-5 NFL pick after 2026. Best defensive player in the SEC. The defense runs through him.
- DT: Lost **T'Vondre Sweat** (NFL). Interior rotation depth is thin.
- LB: **Rasheem Biles** (Ohio State transfer, projected starter). Lost **Anthony Hill Jr.** to early NFL departure (1st round).
- CB: **Derek Williams Jr.** (Penn State transfer, projected CB1). **Devin Sanchez** (5★ target, Houston) is the top remaining portal/recruiting need.
- DC: **Will Muschamp** — veteran coordinator, proven in big games.
- Head coach: **Steve Sarkisian** — program builder, elite recruiter.

2027 Recruiting Class (8 commits, ~#15 On3):
**Easton Royal** (5★ WR, New Orleans), **Cameron Hall** (4★ DE, Arlington TX), **Jackson Cook** (4★ OL, Austin), **Derwin Fields** (4★ EDGE, Mississippi), **Noah Roberts** (4★ RB, Arizona), **Brock Williams** (4★ TE, Illinois), **JT Geraci** (3★ TE), **Karnell James** (3★ S)

CFP Outlook: Texas is a legitimate top-5 program with CFP title aspirations. The Ohio State game in Week 2 is a statement game. Win that, and the path is clear.

If asked about something uncertain: Say "Based on what's been reported as of mid-2026..." and give your honest analytical read. Never fabricate stats or game results. Never criticize individual players personally.`;

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

  let messages;
  try {
    const body = await req.json();
    messages = body.messages;
    if (!Array.isArray(messages) || !messages.length) throw new Error('bad');
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request body. Expected { messages: [...] }' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const xaiRes = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-4',
        stream: true,
        temperature: 0.7,
        instructions: SYSTEM,
        input: messages,
        tools: [{ type: 'web_search' }],
      }),
      signal: AbortSignal.timeout(55000),
    });

    if (!xaiRes.ok) {
      const errText = await xaiRes.text().catch(() => '');
      console.error('[tower/chat] xAI error', xaiRes.status, errText.slice(0, 200));
      return new Response(
        JSON.stringify({ error: 'AI service unavailable', code: xaiRes.status }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // Transform xAI Responses API stream → OpenAI SSE format for the client
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      const reader = xaiRes.body.getReader();
      const decoder = new TextDecoder();
      let leftover = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = leftover + decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          leftover = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
              continue;
            }
            try {
              const event = JSON.parse(raw);
              if (event.type === 'response.output_text.delta' && event.delta) {
                const out = { choices: [{ delta: { content: event.delta }, index: 0 }] };
                await writer.write(encoder.encode(`data: ${JSON.stringify(out)}\n\n`));
              } else if (event.type === 'response.completed') {
                await writer.write(encoder.encode('data: [DONE]\n\n'));
              }
            } catch { /* skip malformed lines */ }
          }
        }
      } finally {
        writer.close().catch(() => {});
      }
    })();

    return new Response(readable, {
      headers: {
        ...CORS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });

  } catch (err) {
    console.error('[tower/chat]', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
}
