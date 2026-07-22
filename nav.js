/**
 * Tower Report — shared application shell.
 * Injects the global nav (and optionally footer + data-freshness strip) so
 * every page renders the identical shell. Include with:
 *
 *   <script src="nav.js" defer></script>                     nav only
 *   <script src="nav.js" data-footer data-status defer></script>
 *
 * Also ensures css/tower.css (shared tokens/components) is loaded.
 */

const NAV_PAGES = [
  { label: 'Home',           href: 'index.html' },
  { label: 'Season Hub',     href: 'schedule.html' },
  { label: 'Roster & Depth', href: 'depth-chart.html' },
  { label: 'Recruiting',     href: 'recruiting.html' },
  { label: 'Stories',        href: 'stories.html' },
  { label: 'Intelligence',   href: 'intelligence.html' },
  { label: 'History',        href: 'history.html' },
];

/* Sub-pages highlight their parent section. */
const NAV_PARENT = {
  'players.html': 'depth-chart.html',
  'roster.html': 'depth-chart.html',
  'player.html': 'depth-chart.html',
  'portal.html': 'recruiting.html',
  'stats.html': 'schedule.html',
  'game-story.html': 'schedule.html',
  'story.html': 'stories.html',
};

const LOGO_SVG = `
  <svg viewBox="0 0 34 42" width="24" height="30" fill="none" aria-hidden="true">
    <rect x="10" y="28" width="14" height="12" fill="#BF5700" opacity=".9"/>
    <rect x="12" y="17" width="10" height="12" fill="#BF5700"/>
    <rect x="14" y="7" width="6" height="11" fill="#BF5700"/>
    <circle cx="17" cy="10" r="2.5" fill="#080808" stroke="#BF5700" stroke-width=".6"/>
    <line x1="17" y1="7" x2="17" y2="2" stroke="#BF5700" stroke-width="1.5"/>
    <circle cx="17" cy="1.5" r="1.3" fill="#E8620A"/>
  </svg>`;

const TR_SHELL_OPTS = (function () {
  const s = document.currentScript;
  return { footer: !!(s && s.hasAttribute('data-footer')), status: !!(s && s.hasAttribute('data-status')) };
})();

function trEnsureSharedCss() {
  if (!document.querySelector('link[href*="tower.css"]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'css/tower.css';
    document.head.appendChild(l);
  }
}

function injectNav() {
  trEnsureSharedCss();
  const current = window.location.pathname.split('/').pop() || 'index.html';
  const activeHref = NAV_PARENT[current] || current;

  const links = NAV_PAGES.map(p => `
    <a href="${p.href}" class="nav-link ${activeHref === p.href ? 'active' : ''}" ${activeHref === p.href ? 'aria-current="page"' : ''}>${p.label}</a>
  `).join('');

  const mobileLinks = NAV_PAGES.map(p => `
    <a href="${p.href}" class="${activeHref === p.href ? 'active' : ''}">${p.label}</a>
  `).join('');

  const navHTML = `
    <a href="#main" class="tr-skip">Skip to content</a>
    <nav id="tr-nav" aria-label="Primary">
      <div class="nav-inner">
        <a href="index.html" class="nav-logo" aria-label="Tower Report home">
          ${LOGO_SVG}
          <span class="nav-logo-text"><span class="nav-logo-top">TOWER</span><span class="nav-logo-sub">REPORT</span></span>
        </a>
        <div class="nav-links">
          ${links}
          <a href="intelligence.html" class="nav-cta">Ask AI</a>
        </div>
        <button class="nav-hamburger" onclick="toggleMobileNav()" aria-label="Menu" aria-expanded="false" aria-controls="nav-mobile">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="nav-mobile" id="nav-mobile">
        ${mobileLinks}
        <a href="intelligence.html" class="mobile-cta">Ask AI</a>
      </div>
    </nav>
    <div id="tr-status" hidden></div>`;

  const style = `
    <style id="tr-nav-style">
      #tr-nav {
        position: sticky; top: 0; z-index: 200;
        background: rgba(8,8,8,0.96);
        backdrop-filter: blur(16px);
        border-bottom: 1px solid rgba(255,255,255,0.08);
        font-family: 'Barlow Condensed', 'Arial Narrow', sans-serif;
      }
      #tr-nav .nav-inner {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0 24px; max-width: 1200px; margin: 0 auto;
      }
      #tr-nav .nav-logo { display: flex; align-items: center; gap: 9px; text-decoration: none; padding: 10px 0; }
      #tr-nav .nav-logo-text { display: flex; flex-direction: column; line-height: 1; }
      #tr-nav .nav-logo-top { font-size: 19px; font-weight: 800; letter-spacing: 3px; color: #F0EBE1; }
      #tr-nav .nav-logo-sub { font-size: 9px; font-weight: 700; letter-spacing: 5px; color: #BF5700; }
      #tr-nav .nav-links { display: flex; gap: 0; align-items: center; }
      #tr-nav .nav-link {
        font-size: 12.5px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
        color: #A09890; text-decoration: none; padding: 20px 12px;
        border-bottom: 2px solid transparent; transition: color .16s, border-color .16s;
      }
      #tr-nav .nav-link:hover { color: #F0EBE1; }
      #tr-nav .nav-link.active { color: #F0EBE1; border-bottom-color: #BF5700; }
      #tr-nav .nav-cta {
        font-size: 12px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
        background: #BF5700; color: #fff; text-decoration: none;
        padding: 9px 16px; margin-left: 10px; border-radius: 3px;
        transition: background .16s;
      }
      #tr-nav .nav-cta:hover { background: #CF6210; }
      #tr-nav .nav-hamburger {
        display: none; background: none; border: none;
        color: #F0EBE1; cursor: pointer; padding: 12px; min-width: 44px; min-height: 44px;
      }
      #tr-nav .nav-mobile {
        display: none; flex-direction: column;
        padding: 8px 20px 16px;
        border-top: 1px solid rgba(255,255,255,0.07);
        background: #0d0d0d;
      }
      #tr-nav .nav-mobile.open { display: flex; }
      #tr-nav .nav-mobile a {
        font-size: 16px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
        color: #C4BCB0; text-decoration: none; padding: 13px 0; min-height: 44px;
        border-bottom: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center;
      }
      #tr-nav .nav-mobile a.active { color: #F0EBE1; box-shadow: inset 3px 0 0 #BF5700; padding-left: 12px; }
      #tr-nav .mobile-cta {
        margin-top: 12px; background: #BF5700; color: #fff !important;
        justify-content: center; border-radius: 3px; border-bottom: none !important;
      }
      #tr-status {
        font: 500 11px 'Inter', sans-serif; letter-spacing: .04em;
        color: #5A5450; background: #0d0d0d; border-bottom: 1px solid rgba(255,255,255,0.05);
        padding: 5px 24px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
      }
      #tr-status[hidden] { display: none; }
      @media (max-width: 900px) {
        #tr-nav .nav-inner { padding: 0 12px 0 16px; }
        #tr-nav .nav-links { display: none; }
        #tr-nav .nav-hamburger { display: flex; align-items: center; justify-content: center; }
        #tr-status { padding: 5px 16px; }
      }
    </style>`;

  document.head.insertAdjacentHTML('beforeend', style);
  document.body.insertAdjacentHTML('afterbegin', navHTML);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('nav-mobile');
      if (m && m.classList.contains('open')) toggleMobileNav();
    }
  });

  if (TR_SHELL_OPTS.status) loadStatusStrip();
  if (TR_SHELL_OPTS.footer) injectFooter();
}

/**
 * Data-freshness strip. Real state only: reads /api/health (pipeline heartbeat).
 * Renders nothing at all if the endpoint is unreachable — never a fake "LIVE".
 * Pipeline runs at 06:00/18:00 UTC, so <13h counts as on-schedule.
 */
async function loadStatusStrip() {
  const el = document.getElementById('tr-status');
  if (!el) return;
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const h = await res.json();
    const last = h.lastRun; // ISO string per api/health.js
    if (!last) return;
    const mins = Math.max(0, Math.round((Date.now() - new Date(last).getTime()) / 60000));
    const rel = mins < 60 ? mins + 'm ago' : mins < 2880 ? Math.round(mins / 60) + 'h ago' : Math.round(mins / 1440) + 'd ago';
    const onSchedule = mins <= 13 * 60;
    el.innerHTML =
      '<span style="color:' + (onSchedule ? '#22c55e' : '#f59e0b') + ';font-weight:600;">' +
      (onSchedule ? '● Data current' : '● Data delayed') + '</span>' +
      '<span>Last pipeline run ' + rel + '</span>' +
      (onSchedule ? '' : '<span>Showing last verified values</span>');
    el.hidden = false;
  } catch (_) { /* strip stays hidden — absence of signal is not an error state */ }
}

function injectFooter() {
  const year = new Date().getFullYear();
  const html = `
  <footer id="tr-footer">
    <div class="trf-inner">
      <div class="trf-brand">
        <div class="trf-name">TOWER<span>REPORT</span></div>
        <p class="trf-tag">Texas Longhorns football intelligence — briefings, roster, recruiting, and season analysis with sources and freshness on every number.</p>
      </div>
      <nav class="trf-cols" aria-label="Footer">
        <div class="trf-col">
          <div class="trf-col-label">Sections</div>
          <a href="stories.html">Latest</a>
          <a href="depth-chart.html">Depth Chart</a>
          <a href="players.html">Players</a>
          <a href="recruiting.html">Recruiting</a>
        </div>
        <div class="trf-col">
          <div class="trf-col-label">Season</div>
          <a href="schedule.html">Schedule</a>
          <a href="schedule.html">Stats &amp; Model</a>
          <a href="history.html">History</a>
          <a href="intelligence.html">Intelligence</a>
        </div>
        <div class="trf-col">
          <div class="trf-col-label">Follow</div>
          <a href="https://x.com/towerreportai" target="_blank" rel="noopener">X / Twitter</a>
          <a href="https://instagram.com/towerreport" target="_blank" rel="noopener">Instagram</a>
        </div>
      </nav>
    </div>
    <div class="trf-legal">
      <span>© ${year} Tower Report · Austin, Texas</span>
      <span>Independent — not affiliated with the University of Texas. Projections are model estimates, not facts.</span>
    </div>
  </footer>
  <style>
    #tr-footer { border-top: 1px solid rgba(255,255,255,0.07); background: #080808; margin-top: 64px; font-family: 'Inter', sans-serif; }
    #tr-footer .trf-inner { max-width: 1200px; margin: 0 auto; padding: 40px 24px 28px; display: flex; gap: 48px; flex-wrap: wrap; justify-content: space-between; }
    #tr-footer .trf-brand { max-width: 340px; }
    #tr-footer .trf-name { font: 800 20px 'Barlow Condensed', sans-serif; letter-spacing: 3px; color: #F0EBE1; }
    #tr-footer .trf-name span { color: #BF5700; }
    #tr-footer .trf-tag { font-size: 12.5px; line-height: 1.6; color: #948C82; margin: 10px 0 0; }
    #tr-footer .trf-cols { display: flex; gap: 48px; flex-wrap: wrap; }
    #tr-footer .trf-col { display: flex; flex-direction: column; gap: 8px; }
    #tr-footer .trf-col-label { font: 600 10.5px 'Inter', sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #5A5450; margin-bottom: 4px; }
    #tr-footer .trf-col a { font-size: 13px; color: #C4BCB0; text-decoration: none; }
    #tr-footer .trf-col a:hover { color: #F0EBE1; }
    #tr-footer .trf-legal { max-width: 1200px; margin: 0 auto; padding: 14px 24px 22px; border-top: 1px solid rgba(255,255,255,0.05); display: flex; gap: 16px; flex-wrap: wrap; justify-content: space-between; font-size: 11.5px; color: #5A5450; }
  </style>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function toggleMobileNav() {
  const m = document.getElementById('nav-mobile');
  const btn = document.querySelector('#tr-nav .nav-hamburger');
  const open = m.classList.toggle('open');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectNav);
} else {
  injectNav();
}
