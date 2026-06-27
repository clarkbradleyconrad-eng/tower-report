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

  const catGrad = `linear-gradient(135deg,#1a0d00 0%,#0f0f0f 60%)`;

  let body = '';
  body += section('What Happened', s.whatHappened);
  body += section('Why It Matters', s.whyItMatters);
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

  if (tags.length) {
    body += `<div class="sr-tags">${tags.map(t => `<span class="sr-tag">${esc(t)}</span>`).join('')}</div>`;
  }

  const shareUrl = escAttr(pageUrl);

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

  <div class="sr-hero" style="background:${catGrad}">
    <div class="sr-hero-inner">
      ${kicker ? `<div class="sr-kicker">${kicker}${category && category !== kicker ? ' &nbsp;·&nbsp; ' + category : ''}</div>` : ''}
      <h1 class="sr-hed">${headline}</h1>
      <div class="sr-meta">
        ${impact ? `<span class="sr-impact">${impact} Impact</span><span class="sr-meta-div"></span>` : ''}
        ${date ? `<span>${date}</span><span class="sr-meta-div"></span>` : ''}
        <span>${readTime} min read</span>
      </div>
    </div>
  </div>

  <div class="sr-body">
    <div class="sr-lead">${esc(hook)}</div>
    ${body}
    ${players ? `<div class="sr-players">Players: ${esc(players)}</div>` : ''}
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
    const [aiStories, dbStories] = await Promise.all([
      fetchBlob(token, 'tower-ai-stories'),
      fetchBlob(token, 'tower-stories'),
    ]);
    story = [...aiStories, ...dbStories].find(s => s.id === id);
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
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">
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

.sr-hero{padding:52px 32px 40px;border-bottom:1px solid var(--border);}
.sr-hero-inner{max-width:760px;margin:0 auto;}
.sr-kicker{font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--orange);margin-bottom:14px;}
.sr-hed{font-family:var(--font-ed);font-size:clamp(24px,4vw,46px);font-weight:700;line-height:1.08;letter-spacing:-.5px;color:var(--white);margin-bottom:18px;}
.sr-meta{display:flex;align-items:center;gap:10px;font-family:var(--font-display);font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--secondary);}
.sr-meta-div{width:1px;height:10px;background:var(--border-mid);}
.sr-impact{color:var(--orange);}

.sr-body{max-width:760px;margin:0 auto;padding:40px 32px 60px;}
.sr-lead{font-family:var(--font-ed);font-size:clamp(16px,2vw,20px);line-height:1.6;color:var(--white2);margin-bottom:36px;padding-bottom:28px;border-bottom:1px solid var(--border);}
.sr-section{margin-bottom:28px;}
.sr-section-lbl{font-family:var(--font-display);font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--orange);margin-bottom:10px;}
.sr-section-body{font-size:15px;line-height:1.72;color:var(--white2);}
.sr-list{padding-left:18px;display:flex;flex-direction:column;gap:8px;}
.sr-list li{font-size:14px;line-height:1.65;color:var(--white2);}
.sr-tower-take{background:var(--s2);border-left:3px solid var(--orange);padding:20px 22px;margin:32px 0;}
.sr-tt-lbl{font-family:var(--font-display);font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--orange);margin-bottom:10px;}
.sr-tower-take p{font-size:14px;line-height:1.72;color:var(--white2);font-style:italic;}
.sr-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:28px;padding-top:24px;border-top:1px solid var(--border);}
.sr-tag{padding:4px 10px;background:var(--s3);border:1px solid var(--border);font-family:var(--font-display);font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--secondary);}
.sr-players{font-family:var(--font-display);font-size:10px;font-weight:600;letter-spacing:1px;color:var(--muted);margin-top:16px;}

.sr-footer{max-width:760px;margin:0 auto;padding:24px 32px 48px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);}
.sr-back-footer{font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--secondary);display:flex;align-items:center;gap:6px;transition:color .15s;}
.sr-back-footer:hover{color:var(--white);}
.sr-share-btn-footer{display:flex;align-items:center;gap:6px;padding:8px 16px;background:transparent;border:1px solid var(--border-mid);color:var(--secondary);font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;transition:all .15s;}
.sr-share-btn-footer:hover{border-color:var(--white2);color:var(--white);}
.sr-share-btn-footer.copied{border-color:var(--orange);color:var(--orange);}

.sr-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--orange);color:#fff;font-family:var(--font-display);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:10px 20px;opacity:0;transition:opacity .2s;pointer-events:none;}
.sr-toast.show{opacity:1;}

@media(max-width:600px){
  .sr-nav{padding:0 16px;}
  .sr-hero{padding:36px 16px 28px;}
  .sr-body{padding:28px 16px 48px;}
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
      document.querySelectorAll('.sr-share-btn, .sr-share-btn-footer').forEach(function(b){ b.classList.add('copied'); });
      toast.classList.add('show');
      setTimeout(function(){
        toast.classList.remove('show');
        document.querySelectorAll('.sr-share-btn, .sr-share-btn-footer').forEach(function(b){ b.classList.remove('copied'); });
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
