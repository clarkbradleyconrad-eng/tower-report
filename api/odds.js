/**
 * Tower Report — /api/odds
 *
 * Returns current market odds for the 2026 Texas schedule.
 *
 * Priority order:
 *   1. The Odds API  (requires ODDS_API_KEY env var)
 *   2. Inline placeholder data (always works, no config needed)
 *
 * Env vars:
 *   ODDS_API_KEY   — The Odds API key (https://the-odds-api.com)
 *   KALSHI_API_KEY — Kalshi API key (future integration, optional)
 *
 * Cache: Vercel edge caches for 6 hours; stale-while-revalidate
 * for 1 hour so users never wait on a cold-miss fetch.
 */

// ---------------------------------------------------------------------------
// Schedule map — links our internal game IDs to real team names + dates.
// The Odds API uses these team names; keep them in sync if they change.
// ---------------------------------------------------------------------------
const SCHEDULE_MAP = [
  { id:'w1',  homeTeam:'Texas Longhorns', awayTeam:'Texas State Bobcats',       date:'2026-09-05', isHome:true  },
  { id:'w2',  homeTeam:'Texas Longhorns', awayTeam:'Ohio State Buckeyes',       date:'2026-09-12', isHome:true  },
  { id:'w3',  homeTeam:'Texas Longhorns', awayTeam:'UTSA Roadrunners',          date:'2026-09-19', isHome:true  },
  { id:'w4',  homeTeam:'Tennessee Volunteers', awayTeam:'Texas Longhorns',      date:'2026-09-26', isHome:false },
  { id:'w5',  homeTeam:'Texas Longhorns', awayTeam:'Oklahoma Sooners',          date:'2026-10-10', isHome:false }, // neutral Cotton Bowl
  { id:'w6',  homeTeam:'Texas Longhorns', awayTeam:'Florida Gators',            date:'2026-10-17', isHome:true  },
  { id:'w7',  homeTeam:'Texas Longhorns', awayTeam:'Ole Miss Rebels',           date:'2026-10-24', isHome:true  },
  { id:'w8',  homeTeam:'Texas Longhorns', awayTeam:'Mississippi State Bulldogs',date:'2026-10-31', isHome:true  },
  { id:'w9',  homeTeam:'Missouri Tigers', awayTeam:'Texas Longhorns',           date:'2026-11-07', isHome:false },
  { id:'w10', homeTeam:'LSU Tigers',      awayTeam:'Texas Longhorns',           date:'2026-11-14', isHome:false },
  { id:'w11', homeTeam:'Texas Longhorns', awayTeam:'Arkansas Razorbacks',       date:'2026-11-21', isHome:true  },
  { id:'w12', homeTeam:'Texas A&M Aggies',awayTeam:'Texas Longhorns',           date:'2026-11-27', isHome:false },
];

// ---------------------------------------------------------------------------
// Placeholder / fallback odds — used when no API key is configured OR the
// season hasn't started yet and The Odds API has no data.
// These reflect pre-season consensus lines as of June 2026.
// Replace with real data by setting ODDS_API_KEY.
// ---------------------------------------------------------------------------
const PLACEHOLDER_ODDS = {
  w1:  { spread:'TEX −38.5', ou:'62.5',  ml:-5000, bookmaker:'consensus' },
  w2:  { spread:'TEX −3.5',  ou:'57.0',  ml:-115,  bookmaker:'consensus' },
  w3:  { spread:'TEX −35',   ou:'58.0',  ml:-3000, bookmaker:'consensus' },
  w4:  { spread:'TN −2.5',   ou:'55.0',  ml:+165,  bookmaker:'consensus' },
  w5:  { spread:'TEX −6',    ou:'59.0',  ml:-165,  bookmaker:'consensus' },
  w6:  { spread:'TEX −7',    ou:'55.0',  ml:-215,  bookmaker:'consensus' },
  w7:  { spread:'TEX −4.5',  ou:'57.0',  ml:-150,  bookmaker:'consensus' },
  w8:  { spread:'TEX −17',   ou:'56.5',  ml:-750,  bookmaker:'consensus' },
  w9:  { spread:'MIZ −1',    ou:'54.0',  ml:+110,  bookmaker:'consensus' },
  w10: { spread:'LSU −1.5',  ou:'56.0',  ml:+120,  bookmaker:'consensus' },
  w11: { spread:'TEX −9',    ou:'58.0',  ml:-260,  bookmaker:'consensus' },
  w12: { spread:'A&M −3',    ou:'52.0',  ml:+130,  bookmaker:'consensus' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert American moneyline to implied win probability (0–100).
 * Does NOT apply the vig removal; this is raw implied probability.
 */
function americanToImplied(ml) {
  if (ml == null) return null;
  const raw = ml < 0
    ? (-ml) / (-ml + 100) * 100
    : 100 / (ml + 100) * 100;
  return parseFloat(raw.toFixed(1));
}

/** Format a moneyline number as a display string (+130, -115). */
function formatML(ml) {
  if (ml == null) return null;
  return ml > 0 ? `+${ml}` : String(ml);
}

/** Determine freshness label and stale flag from a lastUpdated timestamp. */
function getFreshness(lastUpdated) {
  if (!lastUpdated) return { label:'unknown', isStale:true };
  const ageHours = (Date.now() - new Date(lastUpdated).getTime()) / 3600000;
  if (ageHours <  2)   return { label:'live',         isStale:false };
  if (ageHours < 24)   return { label:'updated-today', isStale:false };
  if (ageHours < 48)   return { label:'needs-update',  isStale:true  };
  if (ageHours < 168)  return { label:'stale',         isStale:true  };
  return                      { label:'outdated',      isStale:true  };
}

/** Build a fully-typed odds record for one game from raw data. */
function buildOddsRecord(raw, lastUpdated, source) {
  const ml = raw.ml ?? null;
  const implied = americanToImplied(ml);
  const { label, isStale } = getFreshness(lastUpdated);
  return {
    spread:       raw.spread,
    ou:           raw.ou,
    ml:           formatML(ml),
    mlRaw:        ml,
    impliedWin:   implied != null ? `${implied}%` : null,
    bookmaker:    raw.bookmaker ?? 'consensus',
    lastUpdated,
    source,
    freshness:    label,
    isStale,
  };
}

// ---------------------------------------------------------------------------
// The Odds API integration
// Docs: https://the-odds-api.com/liveapi/guides/v4/
// ---------------------------------------------------------------------------

/**
 * Fetch NCAAF odds from The Odds API and map them to our schedule.
 * Returns a partial map — only games where live lines are available.
 * Games not yet listed by bookmakers will be absent from the result.
 */
async function fetchFromOddsAPI(apiKey) {
  const markets = 'h2h,spreads,totals';
  const regions = 'us';
  const url =
    `https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds/` +
    `?apiKey=${apiKey}&regions=${regions}&markets=${markets}&oddsFormat=american`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Odds API responded ${res.status}`);

  const events = await res.json();
  const result = {};

  for (const game of SCHEDULE_MAP) {
    // Find the matching event — Texas must appear as home or away team
    const event = events.find(e => {
      const homeMatch = e.home_team === game.homeTeam || e.away_team === game.homeTeam;
      const awayMatch = e.home_team === game.awayTeam || e.away_team === game.awayTeam;
      const dateMatch = e.commence_time && e.commence_time.startsWith(game.date);
      return (homeMatch && awayMatch) || (homeMatch && dateMatch);
    });

    if (!event) continue; // Bookmakers haven't listed this game yet

    // Aggregate across bookmakers — prefer DraftKings, fall back to first available
    const bookmaker =
      event.bookmakers.find(b => b.key === 'draftkings') ||
      event.bookmakers.find(b => b.key === 'fanduel') ||
      event.bookmakers[0];

    if (!bookmaker) continue;

    const texasIsHome = event.home_team === 'Texas Longhorns';
    let spread = null, ou = null, ml = null, bkName = bookmaker.title;

    for (const market of bookmaker.markets) {
      if (market.key === 'spreads') {
        const texasLine = market.outcomes.find(o =>
          o.name === 'Texas Longhorns'
        );
        if (texasLine) {
          const pts = texasLine.point;
          const sign = pts < 0 ? '' : '+';
          spread = pts < 0 ? `TEX ${pts}` : `TEX +${pts}`;
        }
      }
      if (market.key === 'totals') {
        const over = market.outcomes.find(o => o.name === 'Over');
        if (over) ou = String(over.point);
      }
      if (market.key === 'h2h') {
        const texasLine = market.outcomes.find(o =>
          o.name === 'Texas Longhorns'
        );
        if (texasLine) ml = texasLine.price;
      }
    }

    const lastUpdated = bookmaker.last_update || new Date().toISOString();
    result[game.id] = buildOddsRecord(
      { spread, ou, ml, bookmaker: bkName },
      lastUpdated,
      'the-odds-api'
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Kalshi stub — future integration
// Kalshi has prediction markets for season outcomes (total wins, CFP berth).
// Add KALSHI_API_KEY to env to enable when integration is ready.
// ---------------------------------------------------------------------------
async function fetchKalshiContext(_apiKey) {
  // TODO: Implement Kalshi season-level market data
  // Suggested markets: "Will Texas make the CFP?", "Texas win total over/under"
  return null;
}

// ---------------------------------------------------------------------------
// Build the full response payload
// ---------------------------------------------------------------------------
async function buildOddsPayload(apiKey) {
  const now = new Date().toISOString();

  // Attempt live fetch
  if (apiKey) {
    try {
      const liveOdds = await fetchFromOddsAPI(apiKey);
      const gameCount = Object.keys(liveOdds).length;

      // Merge live results with placeholder fallback for games not yet listed
      const odds = {};
      for (const game of SCHEDULE_MAP) {
        if (liveOdds[game.id]) {
          odds[game.id] = liveOdds[game.id];
        } else {
          // Game not listed yet — use placeholder with a clear source label
          odds[game.id] = buildOddsRecord(
            PLACEHOLDER_ODDS[game.id],
            null, // no live timestamp → will show as unknown freshness
            'placeholder'
          );
        }
      }

      return {
        odds,
        meta: {
          lastUpdated: now,
          source: 'the-odds-api',
          liveGames: gameCount,
          totalGames: SCHEDULE_MAP.length,
          isStale: false,
          freshness: 'live',
        },
      };
    } catch (err) {
      // Live fetch failed — fall through to placeholder
      console.error('[tower/odds] Live fetch failed:', err.message);
    }
  }

  // Placeholder path (no API key, or live fetch failed)
  const odds = {};
  for (const game of SCHEDULE_MAP) {
    odds[game.id] = buildOddsRecord(
      PLACEHOLDER_ODDS[game.id],
      null,
      'placeholder'
    );
  }

  return {
    odds,
    meta: {
      lastUpdated: null,
      source: 'placeholder',
      liveGames: 0,
      totalGames: SCHEDULE_MAP.length,
      isStale: false,   // placeholder is never "stale" — it's just not live
      freshness: 'placeholder',
      notice: 'Set ODDS_API_KEY in Vercel environment variables to enable live odds.',
    },
  };
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ODDS_API_KEY || null;

  // Vercel cron pings arrive with ?cron=1 — same logic, but we log it
  const isCron = req.query.cron === '1';
  if (isCron) console.log('[tower/odds] Cron refresh triggered');

  try {
    const payload = await buildOddsPayload(apiKey);

    // 6-hour edge cache; stale-while-revalidate serves stale for 1 more hour
    // so zero users ever wait on a cold function call.
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=21600, stale-while-revalidate=3600'
    );
    res.setHeader('Content-Type', 'application/json');

    return res.status(200).json(payload);
  } catch (err) {
    console.error('[tower/odds] Unhandled error:', err);
    return res.status(500).json({
      error: 'Failed to build odds payload',
      meta: { source: 'error', isStale: true, freshness: 'stale' },
    });
  }
}
