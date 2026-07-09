/**
 * Tower Report — /api/story
 * Server-rendered story page with OG meta tags for sharing.
 * Routed via vercel.json rewrite: /story → /api/story
 */
export const config = { runtime: 'edge' };

const BLOB_API = 'https://blob.vercel-storage.com';

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) { return esc(s).replace(/'/g,'&#39;'); }

function impactTier(n) {
  if (n >= 92) return 'ELITE';
  if (n >= 83) return 'HIGH';
  return 'NOTABLE';
}

function tierDesc(n) {
  if (n >= 92) return 'Program-shifting signal. Direct effect on the championship path.';
  if (n >= 83) return 'Moves the depth chart, the odds, or the recruiting board.';
  return 'Stories with scores 75+ move the conversation. High signal. Real edge.';
}

// Real hero art from /img — a newsroom-set imageUrl wins, then keyword
// matches against our actual assets, then the stories hero as default
function heroImage(s) {
  if (s.imageUrl) return s.imageUrl;
  const hay = ((s.headline || s.title || '') + ' ' + (s.tags || []).join(' ')).toLowerCase();
  if (hay.includes('ohio state') || hay.includes('buckeye')) return '/img/texas-osu-2026.png';
  if (hay.includes('vince young') || hay.includes('rose bowl')) return '/img/gs-vy-run-2006.png';
  return '/img/stories-hero-bg.png';
}

async function fetchBlob(token, prefix) {
  try {
    const listRes = await fetch(`${BLOB_API}?prefix=${encodeURIComponent(prefix)}&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) return [];
    const { blobs = [] } = await listRes.json();
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    if (!blobs[0]) return [];
    const dataRes = await fetch(blobs[0].downloadUrl || blobs[0].url);
    if (!dataRes.ok) return [];
    return await dataRes.json();
  } catch { return []; }
}

// A briefing item (tower-briefing blob) rendered through the story template.
// Impact gauge maps from the briefing importance tier.
function briefToStory(b, lastUpdated) {
  const impactMap = { URGENT: 93, HIGH: 86, NORMAL: 78 };
  return {
    id: b.id,
    headline: b.headline,
    kicker: 'DAILY BRIEFING',
    category: b.category || '',
    hook: b.context || '',
    whatHappened: b.whatHappened || b.context || '',
    whyItMatters: b.whyItMatters || '',
    watchNext: b.whatNext ? [b.whatNext] : [],
    impact: impactMap[(b.importance || '').toUpperCase()] || 78,
    date: lastUpdated ? new Date(lastUpdated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    readTime: 2,
    tags: [b.category, 'Daily Briefing'].filter(Boolean),
    sources: b.source ? [b.source] : [],
    sourceUrl: b.url || null,
  };
}

function section(label, body) {
  if (!body) return '';
  return `<div class="sr-section"><div class="sr-section-lbl">${label}</div><div class="sr-section-body">${esc(body)}</div></div>`;
}

function listSection(label, items) {
  if (!items || !items.length) return '';
  const li = items.map(i => `<li>${esc(i)}</li>`).join('');
  return `<div class="sr-section"><div class="sr-section-lbl">${label}</div><ul class="sr-list">${li}</ul></div>`;
}

function renderStory(s, pageUrl) {
  const isNewsroom = !!s.title;
  const headline = esc(s.headline || s.title || '');
  const kicker   = esc(s.kicker || (isNewsroom ? s.categories?.[0] : s.category) || '');
  const category = esc(isNewsroom ? (s.categories?.[0] || '') : (s.category || ''));
  const impact   = s.impact || s.impactScore || null;
  const date     = esc(s.date || (s.publishedAt ? new Date(s.publishedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '') || '');
  const readTime = s.readTime || 4;
  const hook     = s.hook || s.summary || '';
  const players  = (s.players || []).join(', ');
  const tags     = (s.tags || []);

  const heroImg = heroImage(s);

  let body = '';
  body += section('What Happened', s.whatHappened);
  body += section('Football Impact', s.footballImpact);

  if (s.whoItAffects && s.whoItAffects.length) {
    body += listSection('Who It Affects', s.whoItAffects);
  }

  if (isNewsroom) {
    body += section('Impact on Texas', s.impactOnTexas);
    body += section('Future Outlook', s.futureOutlook);
    if (s.keySignals?.length) body += listSection('Key Signals', s.keySignals);
  } else {
    if (s.takeaways?.length) body += listSection('Signal Intelligence', s.takeaways);
    const watchItems = Array.isArray(s.watchNext) ? s.watchNext : (s.watchNext ? [s.watchNext] : []);
    if (watchItems.length) body += listSection('Watch List', watchItems);
    if (s.whatChanges) body += section('What Changes', s.whatChanges);
  }

  if (s.towerTake) {
    body += `<div class="sr-tower-take"><div class="sr-tt-lbl">TOWER TAKE</div><p>${esc(s.towerTake)}</p></div>`;
  }

  const shareUrl = escAttr(pageUrl);

  // Why It Matters callout — pulled out of the section flow into the mock's star box
  const wim = s.whyItMatters ? `
    <div class="sr-wim">
      <div class="sr-wim-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
      <div>
        <div class="sr-wim-lbl">Why It Matters</div>
        <p>${esc(s.whyItMatters)}</p>
      </div>
    </div>` : '';

  // Sidebar cards
  let sidebar = '';
  if (impact) {
    const C = 263.9; // 2πr for r=42
    sidebar += `
    <div class="sr-card">
      <div class="sr-card-lbl">Tower Impact</div>
      <div class="sr-gauge-row">
        <div class="sr-gauge">
          <svg viewBox="0 0 100 100"><circle class="sr-gauge-bg" cx="50" cy="50" r="42"/><circle class="sr-gauge-fill" cx="50" cy="50" r="42" style="stroke-dashoffset:${(C * (1 - Math.min(impact, 100) / 100)).toFixed(1)}"/></svg>
          <div class="sr-gauge-num">${impact}<span>/100</span></div>
        </div>
        <div>
          <div class="sr-gauge-tier">${impactTier(impact)} Impact</div>
          <p class="sr-gauge-desc">${esc(tierDesc(impact))}</p>
          <a href="/stories.html" class="sr-meth">Methodology &rarr;</a>
        </div>
      </div>
    </div>`;
  }
  if (tags.length) {
    sidebar += `
    <div class="sr-card">
      <div class="sr-card-lbl">Story Topics</div>
      <div class="sr-tags">${tags.map(t => `<span class="sr-tag">${esc(t)}</span>`).join('')}</div>
    </div>`;
  }
  if (s.sources && s.sources.length) {
    sidebar += `
    <div class="sr-card">
      <div class="sr-card-lbl">Sources</div>
      <div class="sr-tags">${s.sources.map(t => `<span class="sr-tag">${esc(t)}</span>`).join('')}</div>
      ${s.sourceUrl ? `<a class="sr-src-link" href="${escAttr(s.sourceUrl)}" target="_blank" rel="noopener noreferrer">Original report &#8599;</a>` : ''}
    </div>`;
  }
  sidebar += `
    <div class="sr-card sr-intel">
      <div class="sr-card-lbl sr-intel-lbl">&#9889; Ask Tower Intel</div>
      <p>Get deep, context-aware analysis on this story &mdash; roster fit, CFP implications, and more.</p>
      <a class="sr-intel-btn" href="/intelligence.html">Ask a Question <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></a>
    </div>`;

  return `
  <header class="sr-nav">
    <a href="/stories.html" class="sr-back">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      Stories
    </a>
    <a href="/" class="sr-wordmark">TOWER REPORT</a>
    <button class="sr-share-btn" onclick="doShare('${shareUrl}','${escAttr(s.headline || s.title || '')}')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      Share
    </button>
  </header>

  <div class="sr-hero" style="background-image:url('${escAttr(heroImg)}')">
    <div class="sr-hero-inner">
      <div class="sr-hero-text">
        ${kicker ? `<div class="sr-kicker">${kicker}${category && category !== kicker ? ' &nbsp;·&nbsp; ' + category : ''}</div>` : ''}
        <h1 class="sr-hed">${headline}</h1>
        <div class="sr-meta">
          ${impact ? `<span class="sr-meta-item"><span class="sr-meta-ic"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></span><b>${impact}</b> Impact &middot; ${impactTier(impact)}</span><span class="sr-meta-div"></span>` : ''}
          ${date ? `<span class="sr-meta-item"><span class="sr-meta-ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></span>${date}</span><span class="sr-meta-div"></span>` : ''}
          <span class="sr-meta-item"><span class="sr-meta-ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>${readTime} min read</span>
          <span class="sr-meta-div"></span>
          <button class="sr-meta-item sr-meta-share" onclick="doShare('${shareUrl}','${escAttr(s.headline || s.title || '')}')"><span class="sr-meta-ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></span>Share</button>
        </div>
        ${hook ? `<p class="sr-dek">${esc(hook)}</p>` : ''}
      </div>
    </div>
  </div>

  <div class="sr-layout">
    <article class="sr-article">
      ${wim}
      ${body}
      ${players ? `<div class="sr-players">Players: ${esc(players)}</div>` : ''}
    </article>
    <aside class="sr-sidebar">
      ${sidebar}
    </aside>
  </div>

  <div class="sr-footer">
    <a href="/stories.html" class="sr-back-footer">← Back to all stories</a>
    <button class="sr-share-btn-footer" onclick="doShare('${shareUrl}','${escAttr(s.headline || s.title || '')}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      Share this story
    </button>
  </div>`;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id') || '';
  const origin = `${url.protocol}//${url.host}`;
  const pageUrl = `${origin}/story?id=${encodeURIComponent(id)}`;

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let story = null;

  if (token && id) {
    if (id.startsWith('brief-')) {
      const briefData = await fetchBlob(token, 'tower-briefing');
      const briefs = Array.isArray(briefData) ? briefData : (briefData.briefing || []);
      const brief = briefs.find(b => b.id === id);
      if (brief) story = briefToStory(brief, briefData.lastUpdated);
    } else {
      const [aiStories, dbStories] = await Promise.all([
        fetchBlob(token, 'tower-ai-stories'),
        fetchBlob(token, 'tower-stories'),
      ]);
      // Newsroom stories carry a status — never render unpublished drafts
      const published = dbStories.filter(s => !s.status || s.status === 'published');
      story = [...aiStories, ...published].find(s => s.id === id);
    }
  }

  if (!story) {
    const html404 = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Story Not Found — Tower Report</title>
<style>body{background:#080808;color:#F0EBE1;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;}</style>
</head><body><div style="font-size:11px;letter-spacing:3px;color:#BF5700;font-weight:700;">TOWER REPORT</div>
<h1 style="font-size:24px;">Story not found</h1>
<a href="/stories.html" style="color:#BF5700;font-size:13px;">← Back to stories</a>
</body></html>`;
    return new Response(html404, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const ogTitle = story.headline || story.title || 'Tower Report';
  const ogDesc  = (story.hook || story.summary || '').slice(0, 200);
  const heroSrc = heroImage(story);
  const ogImage = heroSrc.startsWith('http') ? heroSrc : origin + heroSrc;
  const storyHtml = renderStory(story, pageUrl);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(ogTitle)} — Tower Report</title>
<meta name="description" content="${esc(ogDesc)}">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Tower Report · Texas Football Intelligence">
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<meta name="twitter:site" content="@TowerReport">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700;800&display=swap" rel="stylesheet">
<style>
:root{--orange:#BF5700;--black:#080808;--s2:#141414;--s3:#1A1A1A;--s4:#222;--border:rgba(255,255,255,.055);--border-mid:rgba(255,255,255,.10);--white:#F0EBE1;--white2:#C4BCB0;--muted:#5A5450;--secondary:#948C82;--font-display:'Barlow Condensed',sans-serif;--font-ed:'Playfair Display',serif;--font-body:'Barlow',sans-serif;}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{font-family:var(--font-body);background:var(--black);color:var(--white);line-height:1.6;min-height:100vh;}
a{color:inherit;text-decoration:none;}
button{cursor:pointer;font-family:inherit;}

.sr-nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 32px;height:52px;background:rgba(8,8,8,.96);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);}
.sr-back{display:flex;align-items:center;gap:7px;font-family:var(--font-display);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--secondary);transition:color .15s;}
.sr-back:hover{color:var(--white);}
.sr-wordmark{font-family:var(--font-display);font-size:12px;font-weight:800;letter-spacing:4px;text-transform:uppercase;color:var(--orange);}
.sr-share-btn{display:flex;align-items:center;gap:6px;padding:6px 12px;background:transparent;border:1px solid var(--border-mid);color:var(--secondary);font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;transition:all .15s;}
.sr-share-btn:hover{border-color:var(--white2);color:var(--white);}
.sr-share-btn.copied{border-color:var(--orange);color:var(--orange);}

.sr-hero{position:relative;background-color:#050505;background-size:cover;background-position:center right;border-bottom:1px solid var(--border-mid);padding:72px 32px 36px;display:flex;align-items:flex-end;min-height:440px;}
.sr-hero::before{content:'';position:absolute;inset:0;pointer-events:none;background:linear-gradient(to right,rgba(5,5,5,.93) 0%,rgba(5,5,5,.74) 40%,rgba(5,5,5,.22) 75%,rgba(5,5,5,.06) 100%),linear-gradient(to top,rgba(5,5,5,.94) 0%,rgba(5,5,5,.3) 45%,rgba(5,5,5,0) 100%);}
.sr-hero-inner{position:relative;z-index:1;max-width:1180px;margin:0 auto;width:100%;}
.sr-hero-text{max-width:660px;}
.sr-kicker{font-family:var(--font-display);font-size:11px;font-weight:700;letter-spacing:3.5px;text-transform:uppercase;color:var(--orange);margin-bottom:16px;}
.sr-hed{font-family:var(--font-ed);font-size:clamp(28px,4.6vw,56px);font-weight:700;line-height:1.06;letter-spacing:-.5px;color:var(--white);margin-bottom:8px;}
.sr-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:20px;padding:16px 0;border-top:1px solid rgba(255,255,255,.14);}
.sr-meta-item{display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--white2);background:none;border:none;padding:0;}
.sr-meta-item b{font-size:22px;font-weight:800;color:var(--orange);line-height:1;}
.sr-meta-ic{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid rgba(255,255,255,.18);border-radius:50%;color:var(--orange);flex-shrink:0;}
.sr-meta-share{cursor:pointer;transition:color .15s;}
.sr-meta-share:hover{color:var(--white);}
.sr-meta-share.copied{color:var(--orange);}
.sr-meta-div{width:1px;height:22px;background:rgba(255,255,255,.16);}
.sr-dek{font-size:15.5px;line-height:1.72;color:var(--white2);max-width:600px;}

.sr-layout{max-width:1180px;margin:0 auto;padding:40px 32px 64px;display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:36px;align-items:start;}
.sr-article{min-width:0;}
.sr-wim{display:flex;gap:18px;background:var(--s2);border:1px solid var(--border);border-left:3px solid var(--orange);padding:22px;margin-bottom:32px;}
.sr-wim-icon{width:42px;height:42px;border:1px solid rgba(191,87,0,.45);display:flex;align-items:center;justify-content:center;color:var(--orange);flex-shrink:0;}
.sr-wim-lbl{font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--orange);margin-bottom:9px;}
.sr-wim p{font-size:14.5px;line-height:1.78;color:var(--white2);}

.sr-sidebar{position:sticky;top:72px;}
.sr-card{background:var(--s2);border:1px solid var(--border);padding:20px;margin-bottom:14px;}
.sr-card-lbl{font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--orange);margin-bottom:14px;}
.sr-gauge-row{display:flex;gap:18px;align-items:center;}
.sr-gauge{position:relative;width:96px;height:96px;flex-shrink:0;}
.sr-gauge svg{width:100%;height:100%;transform:rotate(-90deg);}
.sr-gauge-bg{fill:none;stroke:rgba(255,255,255,.07);stroke-width:7;}
.sr-gauge-fill{fill:none;stroke:var(--orange);stroke-width:7;stroke-linecap:round;stroke-dasharray:263.9;}
.sr-gauge-num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:var(--font-display);font-size:28px;font-weight:800;color:var(--white);line-height:1;}
.sr-gauge-num span{font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);margin-top:3px;}
.sr-gauge-tier{font-family:var(--font-display);font-size:12px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:var(--white);margin-bottom:6px;}
.sr-gauge-desc{font-size:12px;line-height:1.6;color:var(--secondary);margin-bottom:9px;}
.sr-meth{font-family:var(--font-display);font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--orange);}
.sr-src-link{display:inline-block;margin-top:12px;font-family:var(--font-display);font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);transition:color .15s;}
.sr-src-link:hover{color:var(--orange);}
.sr-intel{background:rgba(191,87,0,.07);border:1px solid rgba(191,87,0,.35);}
.sr-intel-lbl{color:var(--orange);}
.sr-intel p{font-size:12.5px;line-height:1.65;color:var(--white2);margin-bottom:15px;}
.sr-intel-btn{display:flex;align-items:center;justify-content:center;gap:8px;background:var(--orange);color:#fff;padding:12px;font-family:var(--font-display);font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;transition:background .15s;}
.sr-intel-btn:hover{background:#CF6210;}

.sr-section{margin-bottom:28px;}
.sr-section-lbl{font-family:var(--font-display);font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--orange);margin-bottom:10px;}
.sr-section-body{font-size:15px;line-height:1.72;color:var(--white2);}
.sr-list{padding-left:18px;display:flex;flex-direction:column;gap:8px;}
.sr-list li{font-size:14px;line-height:1.65;color:var(--white2);}
.sr-tower-take{background:var(--s2);border-left:3px solid var(--orange);padding:20px 22px;margin:32px 0;}
.sr-tt-lbl{font-family:var(--font-display);font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--orange);margin-bottom:10px;}
.sr-tower-take p{font-size:14px;line-height:1.72;color:var(--white2);font-style:italic;}
.sr-tags{display:flex;flex-wrap:wrap;gap:6px;}
.sr-tag{padding:4px 10px;background:var(--s3);border:1px solid var(--border);font-family:var(--font-display);font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--secondary);}
.sr-players{font-family:var(--font-display);font-size:10px;font-weight:600;letter-spacing:1px;color:var(--muted);margin-top:24px;padding-top:20px;border-top:1px solid var(--border);}

.sr-footer{max-width:1180px;margin:0 auto;padding:24px 32px 48px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);}
.sr-back-footer{font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--secondary);display:flex;align-items:center;gap:6px;transition:color .15s;}
.sr-back-footer:hover{color:var(--white);}
.sr-share-btn-footer{display:flex;align-items:center;gap:6px;padding:8px 16px;background:transparent;border:1px solid var(--border-mid);color:var(--secondary);font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;transition:all .15s;}
.sr-share-btn-footer:hover{border-color:var(--white2);color:var(--white);}
.sr-share-btn-footer.copied{border-color:var(--orange);color:var(--orange);}

.sr-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--orange);color:#fff;font-family:var(--font-display);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:10px 20px;opacity:0;transition:opacity .2s;pointer-events:none;}
.sr-toast.show{opacity:1;}

@media(max-width:900px){
  .sr-layout{grid-template-columns:1fr;gap:24px;}
  .sr-sidebar{position:static;}
}
@media(max-width:600px){
  .sr-nav{padding:0 16px;}
  .sr-hero{padding:48px 16px 24px;min-height:340px;background-position:center;}
  .sr-layout{padding:28px 16px 48px;}
  .sr-meta{gap:10px;}
  .sr-footer{padding:20px 16px 40px;flex-direction:column;gap:14px;align-items:flex-start;}
}
</style>
</head>
<body>
${storyHtml}
<div id="sr-toast" class="sr-toast">Link copied!</div>
<script>
function doShare(url, title) {
  if (navigator.share) {
    navigator.share({ title: title, url: url }).catch(function(){});
  } else {
    navigator.clipboard.writeText(url).then(function() {
      var toast = document.getElementById('sr-toast');
      document.querySelectorAll('.sr-share-btn, .sr-share-btn-footer, .sr-meta-share').forEach(function(b){ b.classList.add('copied'); });
      toast.classList.add('show');
      setTimeout(function(){
        toast.classList.remove('show');
        document.querySelectorAll('.sr-share-btn, .sr-share-btn-footer, .sr-meta-share').forEach(function(b){ b.classList.remove('copied'); });
      }, 2000);
    }).catch(function(){
      window.prompt('Copy this link:', url);
    });
  }
}
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
    },
  });
}
