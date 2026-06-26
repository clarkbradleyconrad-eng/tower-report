(function() {
  'use strict';

  // ─── Data loader (singleton) ─────────────────────────────────────────────
  let _players = null;
  let _loadPromise = null;

  function loadPlayers() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = fetch('./data/players.json')
      .then(r => r.json())
      .then(data => {
        _players = data.players;
        window._playerNames = new Set(_players.map(p => p.name));
        return _players;
      })
      .catch(err => { console.error('[Tower/players] load failed:', err); _players = []; window._playerNames = new Set(); return []; });
    return _loadPromise;
  }

  // ─── Photo URL helper ────────────────────────────────────────────────────
  function ppImg(path) {
    return `https://images.sidearmdev.com/crop?url=https%3A%2F%2Fdxbhsrqyrr690.cloudfront.net%2Fsidearm.nextgen.sites%2Ftexassports_com%2Fimages%2F${encodeURIComponent(path)}&width=300&height=360&type=webp`;
  }

  function initials(name) {
    return (name || '').split(' ').map(n => n.charAt(0)).join('').slice(0, 2);
  }

  function photoHTML(p) {
    if (p.photoPath) {
      return `<img src="${ppImg(p.photoPath)}" alt="${p.name}" onerror="this.parentNode.innerHTML='<div class=pp-initials>${initials(p.name)}</div>'" loading="lazy">`;
    }
    return `<div class="pp-initials">${initials(p.name)}</div>`;
  }

  function posColor(pos) {
    const map = {QB:'#E8620A',RB:'#4ade80',WR:'#60a5fa',TE:'#a78bfa',OT:'#f472b6',OG:'#f472b6',C:'#f472b6',OL:'#f472b6',DE:'#fb923c',DT:'#fb923c',EDGE:'#fb923c',LB:'#facc15',CB:'#34d399',DB:'#34d399',S:'#34d399',K:'#94a3b8',P:'#94a3b8'};
    return map[pos] || '#BF5700';
  }

  // ─── Tab content renderers ───────────────────────────────────────────────
  function renderOverviewTab(p) {
    const rec = p.recruiting || {};
    const nil = p.nil || {};
    const recruitBadge = rec.transferFrom
      ? `<span class="pp-portal-badge">Transfer · ${rec.transferFrom}</span>`
      : rec.stars ? `<span class="pp-stars">${'★'.repeat(rec.stars)}</span>` : '';

    const rankInfo = rec.nationalRank
      ? `<div class="pp-field"><div class="pp-field-label">Nat'l Rank</div><div class="pp-field-val">#${rec.nationalRank}</div></div>
         <div class="pp-field"><div class="pp-field-label">Pos Rank</div><div class="pp-field-val">#${rec.positionRank || '—'}</div></div>
         <div class="pp-field"><div class="pp-field-label">Class</div><div class="pp-field-val">${rec.classYear || '—'}</div></div>`
      : `<div class="pp-field"><div class="pp-field-label">Transfer From</div><div class="pp-field-val">${rec.transferFrom || '—'}</div></div>
         <div class="pp-field"><div class="pp-field-label">Class Year</div><div class="pp-field-val">${rec.classYear || '—'}</div></div>`;

    const links = p.links || {};
    const linkBtns = [
      links.utBio && `<a class="pp-link-btn primary" href="${links.utBio}" target="_blank" rel="noopener">UT Bio →</a>`,
      links.espn && `<a class="pp-link-btn" href="${links.espn}" target="_blank" rel="noopener">ESPN</a>`,
      links.on3 && `<a class="pp-link-btn" href="${links.on3}" target="_blank" rel="noopener">On3</a>`,
      links['247'] && `<a class="pp-link-btn" href="${links['247']}" target="_blank" rel="noopener">247Sports</a>`,
      links.youtube && `<a class="pp-link-btn" href="${links.youtube}" target="_blank" rel="noopener">▶ Highlights</a>`
    ].filter(Boolean).join('');

    const awards = (p.rankings && p.rankings.awards) || [];

    return `
      <div class="pp-section">
        <div class="pp-vitals-grid">
          <div class="pp-vital"><div class="pp-vital-val">${p.height || '—'}</div><div class="pp-vital-lbl">Height</div></div>
          <div class="pp-vital"><div class="pp-vital-val">${p.weight ? p.weight + ' lbs' : '—'}</div><div class="pp-vital-lbl">Weight</div></div>
          <div class="pp-vital"><div class="pp-vital-val">#${p.number}</div><div class="pp-vital-lbl">Jersey</div></div>
          <div class="pp-vital"><div class="pp-vital-val">${p.year}</div><div class="pp-vital-lbl">Year</div></div>
        </div>
      </div>
      ${p.bio ? `<div class="pp-section"><div class="pp-sec-title">Bio</div><div class="pp-bio">${p.bio}</div></div>` : ''}
      <div class="pp-section">
        <div class="pp-sec-title">Recruiting ${recruitBadge}</div>
        <div class="pp-fields-grid">${rankInfo}</div>
        ${nil.value ? `<div class="pp-nil-row"><span class="pp-nil-val">${nil.value}</span> <span class="pp-nil-label">NIL Value · ${nil.source || ''} ${nil.rank ? '· ' + nil.rank : ''}</span></div>` : ''}
      </div>
      ${awards.length ? `<div class="pp-section"><div class="pp-sec-title">Watch Lists</div><div class="pp-tags">${awards.map(a => `<span class="pp-tag">${a}</span>`).join('')}</div></div>` : ''}
      <div class="pp-section">
        <div class="pp-sec-title">External Links</div>
        <div class="pp-links-row">${linkBtns}</div>
      </div>`;
  }

  function renderStatsTab(p) {
    const s = p.stats;
    if (!s) return '<div class="pp-section pp-empty">No stats available.</div>';

    const ds = s.displayStats || [];
    const statCells = ds.map(d => `
      <div class="pp-stat-cell" data-season="${d.season}" data-career="${d.career}">
        <div class="pp-stat-val">${d.season}</div>
        <div class="pp-stat-label">${d.label}</div>
      </div>`).join('');

    let extraStats = '';
    if (s.type === 'passing' && s.season) {
      const ss = s.season;
      extraStats = `
        <div class="pp-extra-stats">
          <div class="pp-extra-row"><span>Completions</span><span>${ss.comp || '—'}/${ss.att || '—'}</span></div>
          <div class="pp-extra-row"><span>Completion %</span><span>${ss.pct || '—'}%</span></div>
          <div class="pp-extra-row"><span>Passing TDs</span><span>${ss.td || '—'}</span></div>
          <div class="pp-extra-row"><span>Interceptions</span><span>${ss.int || '—'}</span></div>
          ${ss.rushYds != null ? `<div class="pp-extra-row"><span>Rush Yards</span><span>${ss.rushYds}</span></div>` : ''}
          ${ss.rushTd != null ? `<div class="pp-extra-row"><span>Rush TDs</span><span>${ss.rushTd}</span></div>` : ''}
          <div class="pp-extra-row"><span>QBR</span><span>${ss.rating || '—'}</span></div>
          <div class="pp-extra-row"><span>Games</span><span>${ss.gp || '—'}</span></div>
        </div>`;
    } else if (s.type === 'rushing' && s.season) {
      const ss = s.season;
      extraStats = `
        <div class="pp-extra-stats">
          <div class="pp-extra-row"><span>Carries</span><span>${ss.att || '—'}</span></div>
          <div class="pp-extra-row"><span>Rush Yards</span><span>${ss.yds || '—'}</span></div>
          <div class="pp-extra-row"><span>Yards/Carry</span><span>${ss.avg || '—'}</span></div>
          <div class="pp-extra-row"><span>Rush TDs</span><span>${ss.td || '—'}</span></div>
          <div class="pp-extra-row"><span>Long</span><span>${ss.long || '—'}</span></div>
          ${ss.rec != null ? `<div class="pp-extra-row"><span>Receptions</span><span>${ss.rec}</span></div>` : ''}
          ${ss.recYds != null ? `<div class="pp-extra-row"><span>Rec Yards</span><span>${ss.recYds}</span></div>` : ''}
          <div class="pp-extra-row"><span>Games</span><span>${ss.gp || '—'}</span></div>
        </div>`;
    } else if (s.type === 'receiving' && s.season) {
      const ss = s.season;
      extraStats = `
        <div class="pp-extra-stats">
          <div class="pp-extra-row"><span>Receptions</span><span>${ss.rec || '—'}</span></div>
          <div class="pp-extra-row"><span>Receiving Yards</span><span>${ss.yds || '—'}</span></div>
          <div class="pp-extra-row"><span>Yards/Rec</span><span>${ss.avg || '—'}</span></div>
          <div class="pp-extra-row"><span>Receiving TDs</span><span>${ss.td || '—'}</span></div>
          <div class="pp-extra-row"><span>Long</span><span>${ss.long || '—'}</span></div>
          ${ss.yac != null ? `<div class="pp-extra-row"><span>Yards After Catch</span><span>${ss.yac}</span></div>` : ''}
          <div class="pp-extra-row"><span>Games</span><span>${ss.gp || '—'}</span></div>
        </div>`;
    } else if (s.type === 'defense' && s.season) {
      const ss = s.season;
      extraStats = `
        <div class="pp-extra-stats">
          <div class="pp-extra-row"><span>Tackles</span><span>${ss.tackles || '—'}</span></div>
          <div class="pp-extra-row"><span>TFLs</span><span>${ss.tfl || '—'}</span></div>
          <div class="pp-extra-row"><span>Sacks</span><span>${ss.sacks || '—'}</span></div>
          ${ss.int != null ? `<div class="pp-extra-row"><span>Interceptions</span><span>${ss.int}</span></div>` : ''}
          ${ss.pd != null ? `<div class="pp-extra-row"><span>Pass Deflections</span><span>${ss.pd}</span></div>` : ''}
          ${ss.ff != null ? `<div class="pp-extra-row"><span>Forced Fumbles</span><span>${ss.ff}</span></div>` : ''}
          ${ss.qbh != null ? `<div class="pp-extra-row"><span>QB Hits</span><span>${ss.qbh}</span></div>` : ''}
          <div class="pp-extra-row"><span>Games</span><span>${ss.gp || '—'}</span></div>
        </div>`;
    } else if (s.type === 'oline' && s.season) {
      const ss = s.season;
      extraStats = `
        <div class="pp-extra-stats">
          <div class="pp-extra-row"><span>Games Played</span><span>${ss.gp || '—'}</span></div>
          <div class="pp-extra-row"><span>Starts</span><span>${ss.starts || '—'}</span></div>
          ${ss.sacksAllowed != null ? `<div class="pp-extra-row"><span>Sacks Allowed</span><span>${ss.sacksAllowed}</span></div>` : ''}
          ${ss.pressuresAllowed != null ? `<div class="pp-extra-row"><span>Pressures Allowed</span><span>${ss.pressuresAllowed}</span></div>` : ''}
        </div>`;
    }

    return `
      <div class="pp-section">
        <div class="pp-stat-toggle">
          <button class="pp-tog active" data-mode="season" onclick="ppStatToggle(this,'season')">2025 Season</button>
          <button class="pp-tog" data-mode="career" onclick="ppStatToggle(this,'career')">Career</button>
        </div>
        <div class="pp-stats-grid" id="pp-stats-grid">${statCells}</div>
      </div>
      ${extraStats}`;
  }

  function renderScoutTab(p) {
    const scout = p.scout || {};
    const strengths = (scout.strengths || []).map(s => `<li>${s}</li>`).join('');
    const weaknesses = (scout.weaknesses || []).map(w => `<li>${w}</li>`).join('');
    const comps = (scout.comps || []).map(c => `<span class="pp-comp">${c}</span>`).join('');
    const nil = p.nil || {};

    return `
      ${strengths ? `<div class="pp-section">
        <div class="pp-sec-title">Strengths</div>
        <ul class="pp-scout-list pp-strengths">${strengths}</ul>
      </div>` : ''}
      ${weaknesses ? `<div class="pp-section">
        <div class="pp-sec-title">Areas to Watch</div>
        <ul class="pp-scout-list pp-weaknesses">${weaknesses}</ul>
      </div>` : ''}
      ${comps ? `<div class="pp-section">
        <div class="pp-sec-title">Player Comps</div>
        <div class="pp-comps">${comps}</div>
      </div>` : ''}
      ${nil.value ? `<div class="pp-section pp-nil-section">
        <div class="pp-sec-title">NIL Value</div>
        <div class="pp-nil-big">${nil.value} <span class="pp-nil-source">· ${nil.source || ''} · ${nil.rank || ''}</span></div>
      </div>` : ''}`;
  }

  function renderNFLTab(p) {
    const draft = p.draft || {};
    const grade = Math.min(100, Math.max(0, draft.grade || 0));
    const teamFits = (draft.teamFits || []).map(t => `<span class="pp-team-fit">${t}</span>`).join('');
    const awards = (p.rankings && p.rankings.awards) || [];

    const gradeLabel = grade >= 90 ? 'Elite Prospect' : grade >= 80 ? 'High-Value Prospect' : grade >= 70 ? 'Day 2 Prospect' : grade >= 60 ? 'Day 3 Prospect' : 'Developmental';

    return `
      <div class="pp-section">
        <div class="pp-sec-title">Draft Projection</div>
        <div class="pp-round-proj">${draft.roundProjection || '—'}</div>
        <div class="pp-grade-row">
          <div class="pp-grade-bar"><div class="pp-grade-fill" style="width:${grade}%"></div></div>
          <div class="pp-grade-vals"><span class="pp-grade-num">${grade}</span><span class="pp-grade-lbl">${gradeLabel}</span></div>
        </div>
      </div>
      ${draft.notes ? `<div class="pp-section"><div class="pp-sec-title">Scout Notes</div><div class="pp-bio">${draft.notes}</div></div>` : ''}
      ${teamFits ? `<div class="pp-section"><div class="pp-sec-title">Team Fits</div><div class="pp-team-fits">${teamFits}</div></div>` : ''}
      ${draft.eligible ? `<div class="pp-section"><div class="pp-sec-title">Draft Eligible</div><div class="pp-eligible">${draft.eligible} NFL Draft</div></div>` : ''}
      ${awards.length ? `<div class="pp-section"><div class="pp-sec-title">Award Watch Lists</div><div class="pp-tags">${awards.map(a => `<span class="pp-tag">${a}</span>`).join('')}</div></div>` : ''}`;
  }

  // ─── Drawer HTML shell ───────────────────────────────────────────────────
  const DRAWER_HTML = `
<div id="pp-overlay">
  <div id="pp-drawer" role="dialog" aria-modal="true">
    <div id="pp-header">
      <div id="pp-hero-photo"></div>
      <div id="pp-hero-info">
        <div id="pp-hero-meta"></div>
        <div id="pp-hero-name"></div>
        <div id="pp-hero-pos"></div>
        <div id="pp-hero-recruit"></div>
        <div id="pp-hero-hometown"></div>
      </div>
      <button id="pp-close" onclick="closePlayerProfile()" aria-label="Close">✕</button>
    </div>
    <div id="pp-tabs">
      <button class="pp-tab active" onclick="ppSwitchTab('overview',this)">Overview</button>
      <button class="pp-tab" onclick="ppSwitchTab('stats',this)">Stats</button>
      <button class="pp-tab" onclick="ppSwitchTab('scout',this)">Scout</button>
      <button class="pp-tab" onclick="ppSwitchTab('nfl',this)">NFL Draft</button>
    </div>
    <div id="pp-body"></div>
  </div>
</div>`;

  const DRAWER_CSS = `
#pp-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:800;opacity:0;pointer-events:none;transition:opacity .25s;}
#pp-overlay.open{opacity:1;pointer-events:all;}
#pp-drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,100vw);background:#111;border-left:1px solid rgba(255,255,255,0.12);z-index:801;transform:translateX(100%);transition:transform .32s cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;overflow:hidden;}
#pp-overlay.open #pp-drawer{transform:translateX(0);}

#pp-header{display:grid;grid-template-columns:110px 1fr 44px;background:#111;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;}
#pp-hero-photo{width:110px;height:132px;overflow:hidden;background:#181818;position:relative;}
#pp-hero-photo img{width:100%;height:100%;object-fit:cover;object-position:top center;}
.pp-initials{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-size:38px;font-weight:900;color:#BF5700;opacity:.3;}
#pp-hero-info{padding:14px 16px;display:flex;flex-direction:column;justify-content:center;gap:3px;overflow:hidden;}
#pp-hero-meta{font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#6B6560;}
#pp-hero-name{font-family:'Playfair Display',serif;font-size:clamp(18px,3vw,24px);font-weight:900;line-height:1.05;color:#F5F0E8;letter-spacing:-.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#pp-hero-pos{font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;}
#pp-hero-recruit{font-family:'Barlow Condensed',sans-serif;font-size:11px;margin-top:4px;display:flex;align-items:center;gap:6px;}
#pp-hero-hometown{font-size:11px;color:#6B6560;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#pp-close{background:none;border:none;color:#6B6560;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:color .15s;padding:0 14px;}
#pp-close:hover{color:#F5F0E8;}

#pp-tabs{display:flex;border-bottom:1px solid rgba(255,255,255,0.07);background:#111;flex-shrink:0;overflow-x:auto;}
.pp-tab{font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#6B6560;padding:12px 18px 13px;border:none;border-bottom:2px solid transparent;background:none;cursor:pointer;white-space:nowrap;transition:all .15s;}
.pp-tab:hover{color:#F5F0E8;}
.pp-tab.active{color:#F5F0E8;border-bottom-color:#BF5700;}

#pp-body{flex:1;overflow-y:auto;background:#111;}

.pp-section{padding:18px 20px;border-bottom:1px solid rgba(255,255,255,0.07);}
.pp-sec-title{font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#BF5700;margin-bottom:10px;}
.pp-bio{font-size:13px;line-height:1.75;color:#A09890;}
.pp-empty{color:#6B6560;font-size:13px;font-style:italic;}

.pp-vitals-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:rgba(255,255,255,0.07);}
.pp-vital{background:#181818;padding:10px 8px;text-align:center;}
.pp-vital-val{font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700;color:#F5F0E8;}
.pp-vital-lbl{font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6B6560;margin-top:2px;}

.pp-fields-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:rgba(255,255,255,0.07);}
.pp-field{background:#181818;padding:10px 12px;}
.pp-field-label{font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6B6560;margin-bottom:2px;}
.pp-field-val{font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;color:#F5F0E8;}

.pp-nil-row{margin-top:12px;display:flex;align-items:center;gap:8px;}
.pp-nil-val{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:700;color:#4ade80;}
.pp-nil-label{font-size:11px;color:#6B6560;}

.pp-tags{display:flex;flex-wrap:wrap;gap:5px;}
.pp-tag{font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;background:#202020;border:1px solid rgba(255,255,255,0.07);color:#6B6560;}

.pp-links-row{display:flex;gap:6px;flex-wrap:wrap;}
.pp-link-btn{font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:7px 12px;border:1px solid rgba(255,255,255,0.12);color:#A09890;text-decoration:none;transition:all .15s;background:none;}
.pp-link-btn:hover{color:#F5F0E8;border-color:rgba(255,255,255,0.25);}
.pp-link-btn.primary{background:#BF5700;border-color:#BF5700;color:#fff;}
.pp-link-btn.primary:hover{background:transparent;color:#BF5700;}

.pp-stars{color:#BF5700;letter-spacing:2px;font-size:15px;}
.pp-portal-badge{font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 8px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);color:#f59e0b;}

.pp-stat-toggle{display:flex;gap:6px;margin-bottom:14px;}
.pp-tog{font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px;background:none;border:1px solid rgba(255,255,255,0.12);color:#6B6560;cursor:pointer;transition:all .15s;}
.pp-tog.active{background:#BF5700;border-color:#BF5700;color:#fff;}

.pp-stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:rgba(255,255,255,0.07);}
.pp-stat-cell{background:#181818;padding:12px 8px;text-align:center;}
.pp-stat-val{font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;color:#F5F0E8;}
.pp-stat-label{font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6B6560;margin-top:3px;}

.pp-extra-stats{padding:0 20px;}
.pp-extra-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px;}
.pp-extra-row span:first-child{color:#A09890;}
.pp-extra-row span:last-child{font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;color:#F5F0E8;}

.pp-scout-list{list-style:none;display:flex;flex-direction:column;gap:8px;}
.pp-scout-list li{font-size:13px;line-height:1.55;color:#A09890;padding-left:14px;position:relative;}
.pp-strengths li::before{content:'';position:absolute;left:0;top:7px;width:6px;height:2px;background:#4ade80;}
.pp-weaknesses li::before{content:'';position:absolute;left:0;top:7px;width:6px;height:2px;background:#f87171;}
.pp-comps{display:flex;gap:8px;flex-wrap:wrap;}
.pp-comp{font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:5px 12px;background:rgba(191,87,0,0.1);border:1px solid rgba(191,87,0,0.25);color:#BF5700;}

.pp-nil-section .pp-nil-big{font-family:'Barlow Condensed',sans-serif;font-size:28px;font-weight:700;color:#4ade80;}
.pp-nil-source{font-size:13px;color:#6B6560;font-weight:400;}

.pp-round-proj{font-family:'Playfair Display',serif;font-size:26px;font-weight:900;color:#F5F0E8;letter-spacing:-.5px;margin-bottom:12px;}
.pp-grade-row{margin-bottom:4px;}
.pp-grade-bar{height:5px;background:#202020;border-radius:2px;margin-bottom:6px;}
.pp-grade-fill{height:100%;border-radius:2px;background:#BF5700;transition:width .5s ease;}
.pp-grade-vals{display:flex;align-items:center;gap:10px;}
.pp-grade-num{font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:700;color:#BF5700;}
.pp-grade-lbl{font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6B6560;}

.pp-team-fits{display:flex;flex-wrap:wrap;gap:5px;}
.pp-team-fit{font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:4px 10px;border:1px solid rgba(255,255,255,0.12);color:#A09890;}
.pp-eligible{font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;color:#F5F0E8;}

.pp-name-link{background:none;border:none;padding:0;font:inherit;color:#BF5700;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;transition:text-decoration-style .15s;}
.pp-name-link:hover{text-decoration-style:solid;}

@media(max-width:600px){#pp-drawer{width:100vw;}#pp-header{grid-template-columns:90px 1fr 40px;}#pp-hero-photo{width:90px;height:108px;}.pp-vitals-grid{grid-template-columns:repeat(2,1fr)}.pp-stats-grid{grid-template-columns:repeat(2,1fr)}.pp-fields-grid{grid-template-columns:repeat(2,1fr)}}
`;

  // ─── Drawer injection & management ───────────────────────────────────────
  let _drawerReady = false;
  let _currentTab = 'overview';
  let _currentPlayer = null;

  function ensureDrawer() {
    if (_drawerReady) return;
    document.body.insertAdjacentHTML('beforeend', DRAWER_HTML);
    const style = document.createElement('style');
    style.id = 'pp-style';
    style.textContent = DRAWER_CSS;
    document.head.appendChild(style);
    document.getElementById('pp-overlay').addEventListener('click', function(e) {
      if (e.target === this) closePlayerProfile();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closePlayerProfile();
    });
    _drawerReady = true;
  }

  function openPlayerProfile(identifier) {
    loadPlayers().then(function(players) {
      const p = players.find(x =>
        x.slug === identifier || x.name === identifier
      );
      if (!p) return;
      _currentPlayer = p;
      ensureDrawer();
      populateHeader(p);
      switchTab('overview');
      document.getElementById('pp-overlay').classList.add('open');
      document.getElementById('pp-drawer').focus();
    });
  }

  function closePlayerProfile() {
    const overlay = document.getElementById('pp-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function populateHeader(p) {
    document.getElementById('pp-hero-photo').innerHTML = photoHTML(p);
    document.getElementById('pp-hero-meta').textContent = `#${p.number} · ${p.position}`;
    document.getElementById('pp-hero-name').textContent = p.name;
    document.getElementById('pp-hero-pos').textContent = p.position + ' · ' + p.year;
    document.getElementById('pp-hero-pos').style.color = posColor(p.position);

    const rec = p.recruiting || {};
    if (rec.transferFrom) {
      document.getElementById('pp-hero-recruit').innerHTML = `<span class="pp-portal-badge">Transfer · ${rec.transferFrom}</span>`;
    } else if (rec.stars) {
      document.getElementById('pp-hero-recruit').innerHTML = `<span class="pp-stars">${'★'.repeat(rec.stars)}</span><span style="font-family:'Barlow Condensed',sans-serif;font-size:10px;color:#6B6560;">${rec.classYear || ''} Class</span>`;
    } else {
      document.getElementById('pp-hero-recruit').innerHTML = '';
    }
    document.getElementById('pp-hero-hometown').textContent = (p.hometown || '') + (p.highSchool ? ' · ' + p.highSchool : '');
  }

  function switchTab(name) {
    _currentTab = name;
    document.querySelectorAll('.pp-tab').forEach(t => t.classList.remove('active'));
    const activeBtn = document.querySelector(`.pp-tab[onclick*="${name}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    const body = document.getElementById('pp-body');
    if (!body || !_currentPlayer) return;
    body.innerHTML = '';

    if (name === 'overview') body.innerHTML = renderOverviewTab(_currentPlayer);
    else if (name === 'stats') body.innerHTML = renderStatsTab(_currentPlayer);
    else if (name === 'scout') body.innerHTML = renderScoutTab(_currentPlayer);
    else if (name === 'nfl') body.innerHTML = renderNFLTab(_currentPlayer);
  }

  // ─── Stat season/career toggle ────────────────────────────────────────────
  window.ppStatToggle = function(btn, mode) {
    document.querySelectorAll('.pp-tog').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.pp-stat-cell').forEach(cell => {
      const val = cell.dataset[mode];
      if (val !== undefined) cell.querySelector('.pp-stat-val').textContent = val;
    });
  };

  window.ppSwitchTab = function(name, btn) {
    switchTab(name);
  };

  // ─── Cross-site player name linking ──────────────────────────────────────
  function linkPlayerNames(containerSelector) {
    if (!_players || !_players.length) return;
    const container = typeof containerSelector === 'string'
      ? document.querySelector(containerSelector)
      : (containerSelector || document.body);
    if (!container) return;

    const names = _players.map(p => p.name).sort((a, b) => b.length - a.length);

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName ? parent.tagName.toLowerCase() : '';
        if (['script','style','a','button','input','textarea','select','option'].includes(tag)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[data-no-link]')) return NodeFilter.FILTER_REJECT;
        if (parent.classList && parent.classList.contains('pp-name-link')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    nodes.forEach(function(textNode) {
      let text = textNode.textContent;
      let found = false;
      const hits = [];

      names.forEach(name => {
        let idx = 0;
        while ((idx = text.indexOf(name, idx)) !== -1) {
          hits.push({ start: idx, end: idx + name.length, name });
          idx += name.length;
        }
      });

      if (!hits.length) return;

      hits.sort((a, b) => a.start - b.start);
      const merged = [];
      hits.forEach(h => {
        if (merged.length && h.start < merged[merged.length - 1].end) return;
        merged.push(h);
      });

      const frag = document.createDocumentFragment();
      let cursor = 0;
      merged.forEach(h => {
        if (h.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, h.start)));
        const btn = document.createElement('button');
        btn.className = 'pp-name-link';
        btn.textContent = h.name;
        btn.setAttribute('data-no-link', '');
        btn.onclick = function() { openPlayerProfile(h.name); };
        frag.appendChild(btn);
        cursor = h.end;
        found = true;
      });
      if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));

      if (found) textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  // ─── Exports ─────────────────────────────────────────────────────────────
  window.openPlayerProfile = openPlayerProfile;
  window.closePlayerProfile = closePlayerProfile;
  window.loadPlayers = loadPlayers;
  window.linkPlayerNames = linkPlayerNames;

  // Preload on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPlayers);
  } else {
    loadPlayers();
  }

})();
