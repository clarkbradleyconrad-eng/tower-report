/**
 * Tower Report — unified data layer client (data/db.json)
 *
 * One fetch, cached for the page's lifetime. Collections (teams, players,
 * games, stories) are objects keyed by id; forward references live in the
 * data (game.playerIds, game.storyIds, story.playerIds, story.gameIds,
 * game.opponentId, player.teamId); reverse lookups are computed here so
 * the JSON never stores both directions.
 *
 * Usage:
 *   TowerDB.load().then(function(db){
 *     db.playersArray                      // sorted curated player profiles
 *     db.getPlayer('arch-manning')
 *     db.getGame('w2')                     // 2026 schedule + historic games
 *     db.getTeam(db.getGame('w2').opponentId)
 *     db.storiesForPlayer('colin-simmons') // reverse ref
 *     db.storiesForGame('w2')              // forward ref, resolved
 *     db.gamesForPlayer('arch-manning')    // reverse ref
 *   });
 */
(function () {
  'use strict';

  var _promise = null;

  function build(raw) {
    var db = {
      raw: raw,
      teams: raw.teams || {},
      players: raw.players || {},
      games: raw.games || {},
      stories: raw.stories || {},
      model: raw.model || null,     // Tower Season Model — single source for projections
      program: raw.program || null, // hand-verified program facts (wins, titles, NFL counts)
    };

    db.playersArray = Object.keys(db.players).map(function (k) { return db.players[k]; })
      .sort(function (a, b) { return (a.number || 999) - (b.number || 999); });

    db.getTeam   = function (id) { return db.teams[id]   || null; };
    db.getPlayer = function (id) { return db.players[id] || null; };
    db.getGame   = function (id) { return db.games[id]   || null; };
    db.getStory  = function (id) { return db.stories[id] || null; };

    function resolve(ids, coll) {
      return (ids || []).map(function (id) { return coll[id]; })
        .filter(function (x) { return !!x; });
    }

    db.playersForGame = function (gameId) {
      var g = db.getGame(gameId);
      return g ? resolve(g.playerIds, db.players) : [];
    };
    db.storiesForGame = function (gameId) {
      var g = db.getGame(gameId);
      return g ? resolve(g.storyIds, db.stories) : [];
    };
    db.playersForStory = function (storyId) {
      var s = db.getStory(storyId);
      return s ? resolve(s.playerIds, db.players) : [];
    };
    db.gamesForStory = function (storyId) {
      var s = db.getStory(storyId);
      return s ? resolve(s.gameIds, db.games) : [];
    };

    // Reverse indexes (player -> games/stories), computed once
    var gamesByPlayer = {}, storiesByPlayer = {};
    Object.keys(db.games).forEach(function (gid) {
      (db.games[gid].playerIds || []).forEach(function (pid) {
        (gamesByPlayer[pid] = gamesByPlayer[pid] || []).push(db.games[gid]);
      });
    });
    Object.keys(db.stories).forEach(function (sid) {
      (db.stories[sid].playerIds || []).forEach(function (pid) {
        (storiesByPlayer[pid] = storiesByPlayer[pid] || []).push(db.stories[sid]);
      });
    });
    db.gamesForPlayer   = function (pid) { return gamesByPlayer[pid]   || []; };
    db.storiesForPlayer = function (pid) { return storiesByPlayer[pid] || []; };

    return db;
  }

  /**
   * Freshness rules (PRODUCT_AUDIT.md §8):
   *   fresh   — within expected source interval
   *   delayed — past interval but < 2× threshold
   *   stale   — beyond threshold
   * "LIVE" must never be shown from static markup; callers derive state here.
   */
  function freshness(dateLike, freshMins) {
    var t = new Date(dateLike).getTime();
    if (!t || isNaN(t)) return { state: 'unavailable', label: 'Data unavailable', mins: null };
    var mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    var state = mins <= freshMins ? 'fresh' : mins <= freshMins * 2 ? 'delayed' : 'stale';
    return { state: state, label: 'Updated ' + relTime(mins), mins: mins };
  }

  function relTime(mins) {
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 48 * 60) return Math.round(mins / 60) + 'h ago';
    return Math.round(mins / 1440) + 'd ago';
  }

  window.TowerDB = {
    freshness: freshness,
    relTime: relTime,
    load: function () {
      if (_promise) return _promise;
      _promise = fetch('./data/db.json')
        .then(function (r) {
          if (!r.ok) throw new Error('db.json HTTP ' + r.status);
          return r.json();
        })
        .then(build)
        .catch(function (err) {
          console.error('[Tower/db] load failed:', err);
          _promise = null; // allow retry on next call
          throw err;
        });
      return _promise;
    },
  };
})();
