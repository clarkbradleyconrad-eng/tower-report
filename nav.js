const NAV_PAGES = [
  { label: 'Home', href: 'index.html' },
  { label: 'Schedule', href: 'schedule.html' },
  { label: 'Roster', href: 'roster.html' },
  { label: 'History', href: 'history.html' },
];

function injectNav() {
  const current = window.location.pathname.split('/').pop() || 'index.html';

  const logoSVG = `
    <svg viewBox="0 0 180 44" width="160" height="40" fill="none">
      <g transform="translate(0,2)">
        <rect x="14" y="28" width="12" height="10" fill="#BF5700" opacity="0.9"/>
        <rect x="15.5" y="18" width="9" height="11" fill="#BF5700"/>
        <rect x="17" y="10" width="6" height="9" fill="#BF5700"/>
        <circle cx="20" cy="13.5" r="2.2" fill="#080808" stroke="#BF5700" stroke-width="0.5"/>
        <line x1="20" y1="10" x2="20" y2="5" stroke="#BF5700" stroke-width="1.5"/>
        <circle cx="20" cy="4.5" r="1" fill="#E8620A"/>
        <line x1="26" y1="15" x2="32" y2="12" stroke="#BF5700" stroke-width="0.8" opacity="0.7"/>
        <circle cx="32.5" cy="11.5" r="1.2" fill="#BF5700" opacity="0.7"/>
        <line x1="14" y1="15" x2="8" y2="12" stroke="#BF5700" stroke-width="0.8" opacity="0.7"/>
        <circle cx="7.5" cy="11.5" r="1.2" fill="#BF5700" opacity="0.7"/>
      </g>
      <text x="44" y="20" font-family="'Barlow Condensed',sans-serif" font-weight="700" font-size="20" letter-spacing="3" fill="#F5F0E8">TOWER</text>
      <text x="44" y="38" font-family="'Barlow Condensed',sans-serif" font-weight="600" font-size="14" letter-spacing="5" fill="#BF5700">REPORT</text>
    </svg>`;

  const links = NAV_PAGES.map(p => `
    <a href="${p.href}" class="nav-link ${current === p.href || (current === '' && p.href === 'index.html') ? 'active' : ''}">${p.label}</a>
  `).join('');

  const navHTML = `
    <nav id="tr-nav">
      <div class="nav-inner">
        <a href="index.html" class="nav-logo">${logoSVG}</a>
        <div class="nav-links">
          ${links}
          <a href="index.html#waitlist" class="nav-cta">Join Waitlist</a>
        </div>
        <button class="nav-hamburger" onclick="toggleMobileNav()" aria-label="Menu">☰</button>
      </div>
      <div class="nav-mobile" id="nav-mobile">
        ${NAV_PAGES.map(p => `<a href="${p.href}" class="${current === p.href ? 'active' : ''}">${p.label}</a>`).join('')}
        <a href="index.html#waitlist" class="mobile-cta">Join Waitlist</a>
      </div>
    </nav>`;

  const style = `
    <style id="tr-nav-style">
      #tr-nav {
        position: sticky; top: 0; z-index: 200;
        background: rgba(8,8,8,0.97);
        backdrop-filter: blur(20px);
        border-bottom: 1px solid rgba(255,255,255,0.07);
        font-family: 'Barlow Condensed', sans-serif;
      }
      #tr-nav .nav-inner {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0 48px; max-width: 1400px; margin: 0 auto;
      }
      #tr-nav .nav-logo { display: flex; align-items: center; text-decoration: none; padding: 12px 0; }
      #tr-nav .nav-links { display: flex; gap: 0; align-items: center; }
      #tr-nav .nav-link {
        font-size: 13px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase;
        color: #6B6560; text-decoration: none; padding: 20px 16px;
        border-bottom: 2px solid transparent; transition: all .2s;
      }
      #tr-nav .nav-link:hover, #tr-nav .nav-link.active {
        color: #F5F0E8; border-bottom-color: #BF5700;
      }
      #tr-nav .nav-cta {
        font-size: 12px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;
        background: #BF5700; color: #fff; text-decoration: none;
        padding: 9px 20px; margin-left: 12px;
        border: 1px solid #BF5700; transition: all .2s;
      }
      #tr-nav .nav-cta:hover { background: transparent; color: #BF5700; }
      #tr-nav .nav-hamburger {
        display: none; background: none; border: none;
        color: #F5F0E8; font-size: 20px; cursor: pointer; padding: 8px;
      }
      #tr-nav .nav-mobile {
        display: none; flex-direction: column;
        padding: 12px 20px 16px;
        border-top: 1px solid rgba(255,255,255,0.07);
        background: #111;
      }
      #tr-nav .nav-mobile.open { display: flex; }
      #tr-nav .nav-mobile a {
        font-size: 14px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase;
        color: #6B6560; text-decoration: none; padding: 12px 0;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        transition: color .15s;
      }
      #tr-nav .nav-mobile a:hover, #tr-nav .nav-mobile a.active { color: #F5F0E8; }
      #tr-nav .mobile-cta {
        margin-top: 12px; background: #BF5700 !important;
        color: #fff !important; text-align: center;
        padding: 12px !important; border: none !important;
      }
      @media (max-width: 768px) {
        #tr-nav .nav-inner { padding: 0 20px; }
        #tr-nav .nav-links { display: none; }
        #tr-nav .nav-hamburger { display: block; }
      }
    </style>`;

  document.head.insertAdjacentHTML('beforeend', style);
  document.body.insertAdjacentHTML('afterbegin', navHTML);
}

function toggleMobileNav() {
  document.getElementById('nav-mobile').classList.toggle('open');
}

// Auto-inject when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectNav);
} else {
  injectNav();
}
