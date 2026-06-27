/**
 * Tower Intel — Context Engine
 *
 * Connects any UI entity (game, story, player, season path) to Longhorn
 * Intelligence with rich context so Grok can give deeply specific answers
 * without the user ever re-typing anything.
 *
 * Usage:
 *   var ctx = TowerIntel.buildContext('game', { opponent:'Ohio State', winProb:54, ... });
 *   TowerIntel.openWithContext('Texas vs. Ohio State', 'Break down this matchup...', ctx);
 *
 * Routing:
 *   - If the current page has #fchat-overlay → uses it directly (injects context banner)
 *   - Otherwise → stores in sessionStorage, navigates to intelligence.html
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.TowerIntel = {

    /**
     * Build a typed context object for a given entity.
     * @param {'game'|'story'|'player'|'season_path'} type
     * @param {object} data  Entity-specific fields (see /api/chat.js for full schema)
     */
    buildContext: function (type, data) {
      return { type: type, ts: Date.now(), data: data || {} };
    },

    /**
     * Open Tower Intel with full entity context.
     *
     * @param {string} label    Short label for the context banner ("Texas vs. Ohio State")
     * @param {string} prompt   The user-facing query to fire
     * @param {object} context  Built via buildContext() — injected server-side into system prompt
     */
    openWithContext: function (label, prompt, context) {
      if (document.getElementById('fchat-overlay')) {
        this._openFChatContext(label, prompt, context);
      } else {
        this._routeToIntelligence(label, prompt, context);
      }
    },

    /* ── Internal: inject into the floating chat on the current page ── */
    _openFChatContext: function (label, prompt, context) {
      var overlay = document.getElementById('fchat-overlay');
      if (!overlay) return;
      overlay.classList.add('open');

      var chips = document.getElementById('fchat-chips');
      if (chips) chips.style.display = 'none';

      var msgs = document.getElementById('fchat-messages');
      if (msgs) {
        msgs.innerHTML = '';
        var banner = document.createElement('div');
        banner.className = 'fchat-msg tower';
        banner.innerHTML =
          '<span style="display:block;font-family:\'Barlow Condensed\',sans-serif;' +
          'font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
          'color:var(--orange);margin-bottom:5px;">⚡ Tower Intel · Context Mode</span>' +
          '<strong>' + esc(label) + '</strong>' +
          '<span style="display:block;color:var(--muted);font-size:11px;' +
          'font-style:italic;margin-top:4px;">Building context-aware analysis…</span>';
        msgs.appendChild(banner);
      }

      setTimeout(function () {
        if (typeof window.fchatAsk === 'function') {
          window.fchatAsk(prompt, context);
        }
      }, 480);
    },

    /* ── Internal: store in sessionStorage, navigate to intelligence.html ── */
    _routeToIntelligence: function (label, prompt, context) {
      try {
        sessionStorage.setItem('ti_label', label || '');
        sessionStorage.setItem('ti_prompt', prompt || '');
        sessionStorage.setItem('ti_context', context ? JSON.stringify(context) : '');
      } catch (e) {}
      window.location.href = 'intelligence.html';
    }
  };

})();
