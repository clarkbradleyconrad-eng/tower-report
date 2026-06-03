/**
 * Tower Report — /api/admin-refresh
 *
 * Protected endpoint to manually trigger an odds refresh and bypass
 * Vercel's edge cache. Returns fresh odds data directly.
 *
 * Usage:
 *   GET /api/admin-refresh?token=YOUR_ADMIN_TOKEN
 *
 * Protection:
 *   Set ADMIN_REFRESH_TOKEN in Vercel environment variables.
 *   If the env var is not set, the endpoint is disabled entirely.
 *
 * This endpoint is intentionally NOT linked anywhere in the public UI.
 * Access it directly from a browser or curl during manual updates.
 *
 * curl example:
 *   curl "https://tower-report.vercel.app/api/admin-refresh?token=abc123"
 *
 * From the browser dev console on your site:
 *   window.towerAdminRefresh('YOUR_TOKEN')
 */

// Re-use the same odds logic from the main handler
// (Vercel bundles each file independently, so we duplicate the core here)

const SCHEDULE_MAP = [
  { id:'w1',  homeTeam:'Texas Longhorns', awayTeam:'Texas State Bobcats',        date:'2026-09-05' },
  { id:'w2',  homeTeam:'Texas Longhorns', awayTeam:'Ohio State Buckeyes',        date:'2026-09-12' },
  { id:'w3',  homeTeam:'Texas Longhorns', awayTeam:'UTSA Roadrunners',           date:'2026-09-19' },
  { id:'w4',  homeTeam:'Tennessee Volunteers', awayTeam:'Texas Longhorns',       date:'2026-09-26' },
  { id:'w5',  homeTeam:'Texas Longhorns', awayTeam:'Oklahoma Sooners',           date:'2026-10-10' },
  { id:'w6',  homeTeam:'Texas Longhorns', awayTeam:'Florida Gators',             date:'2026-10-17' },
  { id:'w7',  homeTeam:'Texas Longhorns', awayTeam:'Ole Miss Rebels',            date:'2026-10-24' },
  { id:'w8',  homeTeam:'Texas Longhorns', awayTeam:'Mississippi State Bulldogs', date:'2026-10-31' },
  { id:'w9',  homeTeam:'Missouri Tigers', awayTeam:'Texas Longhorns',            date:'2026-11-07' },
  { id:'w10', homeTeam:'LSU Tigers',      awayTeam:'Texas Longhorns',            date:'2026-11-14' },
  { id:'w11', homeTeam:'Texas Longhorns', awayTeam:'Arkansas Razorbacks',        date:'2026-11-21' },
  { id:'w12', homeTeam:'Texas A&M Aggies',awayTeam:'Texas Longhorns',            date:'2026-11-27' },
];

const PLACEHOLDER_ODDS = {
  w1:  { spread:'TEX −38.5', ou:'62.5',  ml:-5000 },
  w2:  { spread:'TEX −3.5',  ou:'57.0',  ml:-115  },
  w3:  { spread:'TEX −35',   ou:'58.0',  ml:-3000 },
  w4:  { spread:'TN −2.5',   ou:'55.0',  ml:+165  },
  w5:  { spread:'TEX −6',    ou:'59.0',  ml:-165  },
  w6:  { spread:'TEX −7',    ou:'55.0',  ml:-215  },
  w7:  { spread:'TEX −4.5',  ou:'57.0',  ml:-150  },
  w8:  { spread:'TEX −17',   ou:'56.5',  ml:-750  },
  w9:  { spread:'MIZ −1',    ou:'54.0',  ml:+110  },
  w10: { spread:'LSU −1.5',  ou:'56.0',  ml:+120  },
  w11: { spread:'TEX −9',    ou:'58.0',  ml:-260  },
  w12: { spread:'A&M −3',    ou:'52.0',  ml:+130  },
};

function americanToImplied(ml) {
  if (ml == null) return null;
  const raw = ml < 0 ? (-ml) / (-ml + 100) * 100 : 100 / (ml + 100) * 100;
  return parseFloat(raw.toFixed(1));
}

function formatML(ml) {
  if (ml == null) return null;
  return ml > 0 ? `+${ml}` : String(ml);
}

function buildRecord(raw, lastUpdated, source) {
  const ml = raw.ml ?? null;
  const implied = americanToImplied(ml);
  return {
    spread:     raw.spread,
    ou:         raw.ou,
    ml:         formatML(ml),
    mlRaw:      ml,
    impliedWin: implied != null ? `${implied}%` : null,
    bookmaker:  raw.bookmaker ?? 'consensus',
    lastUpdated,
    source,
    freshness:  lastUpdated ? 'live' : 'placeholder',
    isStale:    false,
  };
}

async function fetchLive(apiKey) {
  const url =
    `https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds/` +
    `?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Odds API ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- Auth check ----
  const secret = process.env.ADMIN_REFRESH_TOKEN;
  if (!secret) {
    return res.status(503).json({
      error: 'Admin refresh is disabled. Set ADMIN_REFRESH_TOKEN in Vercel env vars to enable.',
    });
  }

  const { token } = req.query;
  if (!token || token !== secret) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or missing token.' });
  }

  // ---- Fetch ----
  const apiKey = process.env.ODDS_API_KEY || null;
  const now = new Date().toISOString();
  let odds = {};
  let source = 'placeholder';
  let liveCount = 0;

  if (apiKey) {
    try {
      const events = await fetchLive(apiKey);

      for (const game of SCHEDULE_MAP) {
        const event = events.find(e =>
          (e.home_team === game.homeTeam || e.away_team === game.homeTeam) &&
          (e.home_team === game.awayTeam || e.away_team === game.awayTeam)
        );
        if (!event) continue;

        const bk =
          event.bookmakers.find(b => b.key === 'draftkings') ||
          event.bookmakers.find(b => b.key === 'fanduel') ||
          event.bookmakers[0];
        if (!bk) continue;

        let spread = null, ou = null, ml = null;
        for (const m of bk.markets) {
          if (m.key === 'spreads') {
            const tx = m.outcomes.find(o => o.name === 'Texas Longhorns');
            if (tx) spread = tx.point < 0 ? `TEX ${tx.point}` : `TEX +${tx.point}`;
          }
          if (m.key === 'totals') {
            const over = m.outcomes.find(o => o.name === 'Over');
            if (over) ou = String(over.point);
          }
          if (m.key === 'h2h') {
            const tx = m.outcomes.find(o => o.name === 'Texas Longhorns');
            if (tx) ml = tx.price;
          }
        }

        odds[game.id] = buildRecord(
          { spread, ou, ml, bookmaker: bk.title },
          bk.last_update || now,
          'the-odds-api'
        );
        liveCount++;
      }
      source = 'the-odds-api';
    } catch (err) {
      console.error('[tower/admin-refresh] Live fetch failed:', err.message);
      source = 'placeholder-fallback';
    }
  }

  // Fill any gaps with placeholder
  for (const game of SCHEDULE_MAP) {
    if (!odds[game.id]) {
      odds[game.id] = buildRecord(PLACEHOLDER_ODDS[game.id], null, 'placeholder');
    }
  }

  // No caching on admin endpoint — always fresh
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  return res.status(200).json({
    odds,
    meta: {
      lastUpdated: now,
      source,
      liveGames: liveCount,
      totalGames: SCHEDULE_MAP.length,
      isStale: false,
      freshness: liveCount > 0 ? 'live' : 'placeholder',
      triggeredBy: 'admin-manual',
    },
  });
}
