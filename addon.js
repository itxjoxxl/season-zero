const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

// ─── CONFIG STORE ─────────────────────────────────────────────────────────────
// API keys are NEVER stored server-side. The key travels in the URL only,
// as a compressed base64 segment that only the user's browser ever handles.
//
// URL format (short):   /s/{configId}/{keyToken}/manifest.json
//   configId  = 8-char hash ID → stored in Upstash (preferred) or filesystem
//   keyToken  = compressed base64 of {tmdbApiKey, topN, showAutoSeason}
//
// Legacy inline format: /{fullBase64Config}/manifest.json  (backwards compat)
//
// Storage priority: Upstash Redis (persistent across deploys) → filesystem (dev)

// ── Upstash REST helper ────────────────────────────────────────────────────────
const UPSTASH_URL   = process.env.UPSTASH_REDIS_URL   || null;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_TOKEN || null;

async function upstashSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  try {
    await axios.post(UPSTASH_URL + '/set/' + encodeURIComponent(key),
      JSON.stringify(value),
      { headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' }, timeout: 5000 }
    );
    return true;
  } catch(e) { console.warn('[GoodTaste] Upstash set failed:', e.message); return false; }
}

async function upstashGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const r = await axios.get(UPSTASH_URL + '/get/' + encodeURIComponent(key),
      { headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN }, timeout: 5000 }
    );
    if (r.data && r.data.result != null) return JSON.parse(r.data.result);
    return null;
  } catch(e) { console.warn('[GoodTaste] Upstash get failed:', e.message); return null; }
}

// ── Filesystem fallback ────────────────────────────────────────────────────────
const CONFIGS_DIR = path.join(__dirname, 'configs');
try { if (!fs.existsSync(CONFIGS_DIR)) fs.mkdirSync(CONFIGS_DIR, { recursive: true }); }
catch(e) { console.warn('[GoodTaste] Could not create configs dir:', e.message); }

function fsWriteConfig(id, obj) {
  try { fs.writeFileSync(path.join(CONFIGS_DIR, id + '.json'), JSON.stringify(obj), 'utf8'); return true; }
  catch(e) { return false; }
}
function fsReadConfig(id) {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, id + '.json'), 'utf8')); }
  catch(e) { return null; }
}

// ── Save / load (Upstash preferred, fs fallback) ───────────────────────────────
// cfgObj must NOT contain tmdbApiKey — callers strip it before calling here.
async function saveConfig(cfgObj) {
  const json = JSON.stringify(cfgObj);
  const id = crypto.createHash('sha256').update(json).digest('base64url').slice(0, 8);
  const saved = await upstashSet('gt:cfg:' + id, cfgObj);  // pass object; upstashSet handles serialization
  if (!saved) fsWriteConfig(id, cfgObj);   // filesystem fallback
  return id;
}

async function loadConfig(id) {
  if (!/^[A-Za-z0-9_-]{6,12}$/.test(id)) return null;
  const fromUpstash = await upstashGet('gt:cfg:' + id);
  if (fromUpstash) return fromUpstash;
  return fsReadConfig(id);   // filesystem fallback
}

// ── Compression helpers (server-side, for legacy inline tokens) ────────────────
function deflateB64(str) {
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(Buffer.from(str, 'utf8'), (err, buf) => {
      if (err) reject(err);
      else resolve(buf.toString('base64url'));
    });
  });
}
function inflateB64(token) {
  try {
    // Try deflate-compressed base64url first
    const buf = Buffer.from(token, 'base64url');
    return JSON.parse(zlib.inflateRawSync(buf).toString('utf8'));
  } catch(e) {
    // Fall back to plain base64 (legacy)
    try { return JSON.parse(Buffer.from(token, 'base64').toString('utf8')); }
    catch(e2) { return null; }
  }
}

// ── parseConfig: handles all token formats ─────────────────────────────────────
// For short-URL requests, key is injected separately — see mergeKey() below.
function parseConfig(token) {
  if (!token) return {};
  // Plain base64 / compressed base64 inline config (legacy)
  const obj = inflateB64(token);
  return obj || {};
}

// Merge a keyToken (compressed base64 of {tmdbApiKey, topN, showAutoSeason})
// back into a config object loaded from the store.
function decodeKeyToken(keyToken) {
  if (!keyToken) return {};
  try {
    const buf = Buffer.from(keyToken, 'base64url');
    return JSON.parse(zlib.inflateRawSync(buf).toString('utf8'));
  } catch(e) {
    try { return JSON.parse(Buffer.from(keyToken, 'base64').toString('utf8')); }
    catch(e2) { return {}; }
  }
}

// Load boost presets from separate file (edit boosts.js to add/change boosts)
let BOOST_PRESETS = [];
try {
  BOOST_PRESETS = require('./boosts.js').BOOST_PRESETS || [];
} catch(e) {
  console.warn('[GoodTaste] boosts.js not found — boost gallery will be empty.');
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

const TMDB_IMG_SM = 'https://image.tmdb.org/t/p/w300';
const TMDB_IMG_MD = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMG_LG = 'https://image.tmdb.org/t/p/w1280';
const TMDB_BASE   = 'https://api.themoviedb.org/3';

// Genre ID → name lookup (avoids raw numeric IDs in catalog metas)
const TMDB_GENRE_MAP = {
  movie: {
    28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',
    99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',
    27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Science Fiction',
    10770:'TV Movie',53:'Thriller',10752:'War',37:'Western'
  },
  tv: {
    10759:'Action & Adventure',16:'Animation',35:'Comedy',80:'Crime',
    99:'Documentary',18:'Drama',10751:'Family',10762:'Kids',9648:'Mystery',
    10763:'News',10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',
    10767:'Talk',10768:'War & Politics',37:'Western'
  }
};

const DEFAULT_CATALOGS = [
  { id: 'tmdb.trending_movies',   type: 'movie',  name: 'Trending Movies',   path: '/trending/movie/week', enabled: true  },
  { id: 'tmdb.popular_movies',    type: 'movie',  name: 'Popular Movies',     path: '/movie/popular',       enabled: true  },
  { id: 'tmdb.top_rated_movies',  type: 'movie',  name: 'Top Rated Movies',   path: '/movie/top_rated',     enabled: true  },
  { id: 'tmdb.upcoming_movies',   type: 'movie',  name: 'Upcoming Movies',    path: '/movie/upcoming',      enabled: false },
  { id: 'tmdb.nowplaying_movies', type: 'movie',  name: 'Now Playing Movies', path: '/movie/now_playing',   enabled: false },
  { id: 'tmdb.trending_series',   type: 'series', name: 'Trending Series',    path: '/trending/tv/week',    enabled: true  },
  { id: 'tmdb.popular_series',    type: 'series', name: 'Popular Series',     path: '/tv/popular',          enabled: true  },
  { id: 'tmdb.top_rated_series',  type: 'series', name: 'Top Rated Series',   path: '/tv/top_rated',        enabled: true  },
  { id: 'tmdb.airing_today',      type: 'series', name: 'Airing Today',       path: '/tv/airing_today',     enabled: false },
  { id: 'tmdb.on_the_air',        type: 'series', name: 'On The Air',         path: '/tv/on_the_air',       enabled: false },
];


async function tmdb(path, apiKey, params = {}) {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const { data } = await axios.get(url.toString());
  return data;
}

function extractId(id) { return id.replace(/^tmdb:/, ''); }

async function getMovie(tmdbId, apiKey) {
  return tmdb('/movie/' + tmdbId, apiKey, { append_to_response: 'external_ids,release_dates,credits,videos,images', include_image_language: 'en,null' });
}
async function getSeries(tmdbId, apiKey) {
  return tmdb('/tv/' + tmdbId, apiKey, { append_to_response: 'external_ids,content_ratings,credits,images', include_image_language: 'en,null' });
}

// Pick the best logo from a TMDB images response
function getBestLogo(images) {
  const logos = (images && images.logos || [])
    .filter(l => l.file_path && (!l.iso_639_1 || l.iso_639_1 === 'en'))
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  return logos[0] ? 'https://image.tmdb.org/t/p/w500' + logos[0].file_path : null;
}
async function getSeason(tmdbId, seasonNum, apiKey) {
  return tmdb('/tv/' + tmdbId + '/season/' + seasonNum, apiKey);
}

async function getAllEpisodes(tmdbId, apiKey, totalSeasons) {
  const episodes = [];
  for (let s = 1; s <= totalSeasons; s++) {
    try {
      const season = await getSeason(tmdbId, s, apiKey);
      for (const ep of (season.episodes || [])) {
        episodes.push({
          season: s, episode: ep.episode_number, name: ep.name,
          overview: ep.overview || '',
          still: ep.still_path ? TMDB_IMG_SM + ep.still_path : null,
          vote_average: ep.vote_average || 0, vote_count: ep.vote_count || 0,
          air_date: ep.air_date,
        });
      }
    } catch (e) { /* skip broken seasons */ }
  }
  return episodes;
}

async function getTopEpisodes(tmdbId, apiKey, totalSeasons, topN) {
  topN = topN || 20;
  const all = await getAllEpisodes(tmdbId, apiKey, totalSeasons);
  const filtered = all.filter(e => e.vote_count >= 5);
  filtered.sort((a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count);
  return filtered.slice(0, topN);
}

function getSeriesCert(data) {
  try {
    const us = (data.content_ratings && data.content_ratings.results || []).find(r => r.iso_3166_1 === 'US');
    return us && us.rating || null;
  } catch (e) { return null; }
}
function getMovieCert(data) {
  try {
    const us = (data.release_dates && data.release_dates.results || []).find(r => r.iso_3166_1 === 'US');
    const rel = (us && us.release_dates || []).find(d => d.type === 3 || d.type === 4);
    return rel && rel.certification || null;
  } catch (e) { return null; }
}

function movieToMeta(m) {
  return {
    id: 'tmdb:' + m.id, type: 'movie',
    name: m.title || m.original_title || 'Unknown',
    poster: m.poster_path ? TMDB_IMG_MD + m.poster_path : null,
    background: m.backdrop_path ? TMDB_IMG_LG + m.backdrop_path : null,
    description: m.overview || '',
    releaseInfo: m.release_date ? m.release_date.substring(0, 4) : '',
    imdbRating: m.vote_average ? m.vote_average.toFixed(1) : null,
    genres: (m.genre_ids
      ? m.genre_ids.map(id => TMDB_GENRE_MAP.movie[id] || null).filter(Boolean)
      : (m.genres || []).map(g => g.name)),
  };
}
function seriesToMeta(s) {
  return {
    id: 'tmdb:' + s.id, type: 'series',
    name: s.name || s.original_name || 'Unknown',
    poster: s.poster_path ? TMDB_IMG_MD + s.poster_path : null,
    background: s.backdrop_path ? TMDB_IMG_LG + s.backdrop_path : null,
    description: s.overview || '',
    releaseInfo: s.first_air_date ? s.first_air_date.substring(0, 4) : '',
    imdbRating: s.vote_average ? s.vote_average.toFixed(1) : null,
    genres: (s.genre_ids
      ? s.genre_ids.map(id => TMDB_GENRE_MAP.tv[id] || null).filter(Boolean)
      : (s.genres || []).map(g => g.name)),
  };
}

function buildBestOfVideos(bestOfEps, imdbId, tmdbId) {
  return bestOfEps.map(function(ep, i) {
    const rank = i + 1;
    const sLabel = String(ep.season).padStart(2, '0');
    const eLabel = String(ep.episode).padStart(2, '0');
    const ratingLine = ep.vote_average > 0
      ? ep.vote_average.toFixed(1) + '/10  (' + ep.vote_count.toLocaleString() + ' votes)\n\n' : '';
    const videoId = imdbId
      ? imdbId + ':' + ep.season + ':' + ep.episode
      : 'tmdb:' + tmdbId + ':' + ep.season + ':' + ep.episode;
    return {
      id: videoId,
      title: '#' + rank + ' \u2014 S' + sLabel + 'E' + eLabel + ' \u2014 ' + ep.name,
      season: 1, episode: rank,
      overview: ratingLine + (ep.overview || ''),
      thumbnail: ep.still || null,
      released: ep.air_date ? new Date(ep.air_date) : null,
    };
  });
}

function buildManifest(config) {
  const cfg = config ? parseConfig(config) : {};

  const enabledDefaults = DEFAULT_CATALOGS.filter(d => {
    const override = cfg.catalogEnabled && cfg.catalogEnabled[d.id];
    if (override === false) return false;
    if (override === true) return true;
    return d.enabled;
  });

  if (cfg.defaultCatalogOrder && Array.isArray(cfg.defaultCatalogOrder)) {
    const order = cfg.defaultCatalogOrder;
    enabledDefaults.sort((a, b) => {
      const ai = order.findIndex(o => (o.id || o) === a.id);
      const bi = order.findIndex(o => (o.id || o) === b.id);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  }

  const customCatalogs = (cfg.customCatalogs || []).filter(c => c.enabled !== false);
  const customSeasons  = cfg.customSeasons || [];

  const defaultMap = new Map(enabledDefaults.map(d => [d.id, d]));
  const customMap  = new Map(customCatalogs.map(c => [c.id, c]));

  const allCatalogs = [];
  if (cfg.defaultCatalogOrder && Array.isArray(cfg.defaultCatalogOrder)) {
    const seen = new Set();
    for (const entry of cfg.defaultCatalogOrder) {
      const kind = entry.kind || 'default';
      const id   = entry.id || entry;
      if (kind === 'bestof' && id === 'tmdb.bestof' && customSeasons.length > 0 && !seen.has('bestof:tmdb.bestof')) {
        const bestofName = (cfg.catalogNames && cfg.catalogNames['tmdb.bestof']) ? cfg.catalogNames['tmdb.bestof'] : '\u2728 Curated Lists';
        allCatalogs.push({ id: 'tmdb.bestof', type: 'series', name: bestofName, extra: [] });
        seen.add('bestof:tmdb.bestof');
      } else if (kind === 'default' && defaultMap.has(id) && !seen.has('d:'+id)) {
        const d = defaultMap.get(id);
        const rawName = cfg.catalogNames && cfg.catalogNames[id] ? cfg.catalogNames[id] : d.name;
        const displayName = rawName.replace(/\s+(movies?|series|shows?)$/i, '').trim() || rawName;
        allCatalogs.push({ id: d.id, type: d.type, name: displayName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
        seen.add('d:'+id);
      } else if (kind === 'custom' && customMap.has(id) && !seen.has('c:'+id)) {
        const c = customMap.get(id);
        // FIX: strip suffix from custom catalog names in manifest
        const cleanName = (c.name || 'Custom').replace(/\s+(movies?|series|shows?)$/i, '').trim() || c.name;
        // FIX: for _custom_items_ catalogs with mixed types, register for both movie and series
        if (c.path === '_custom_items_' && (c.items || c.bestofListIds)) {
          const items = c.items || [];
          const hasBestof = c.bestofListIds && c.bestofListIds.length > 0;
          const hasMovies = items.some(i => i.itemType === 'movie');
          const hasSeries = items.some(i => i.itemType === 'series') || hasBestof;
          if (hasMovies && hasSeries) {
            allCatalogs.push({ id: c.id, type: 'movie',  name: cleanName, extra: [{ name: 'skip', isRequired: false }] });
            allCatalogs.push({ id: c.id, type: 'series', name: cleanName, extra: [{ name: 'skip', isRequired: false }] });
          } else if (hasSeries) {
            allCatalogs.push({ id: c.id, type: 'series', name: cleanName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
          } else {
            allCatalogs.push({ id: c.id, type: c.type, name: cleanName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
          }
        } else {
          allCatalogs.push({ id: c.id, type: c.type, name: cleanName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
        }
        seen.add('c:'+id);
      }
    }
    enabledDefaults.forEach(d => {
      if (!seen.has('d:'+d.id)) {
        const rawName = cfg.catalogNames && cfg.catalogNames[d.id] ? cfg.catalogNames[d.id] : d.name;
        const displayName = rawName.replace(/\s+(movies?|series|shows?)$/i, '').trim() || rawName;
        allCatalogs.push({ id: d.id, type: d.type, name: displayName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
      }
    });
    customCatalogs.forEach(c => {
      if (!seen.has('c:'+c.id)) {
        const cleanName = (c.name || 'Custom').replace(/\s+(movies?|series|shows?)$/i, '').trim() || c.name;
        if (c.path === '_custom_items_' && (c.items || c.bestofListIds)) {
          const items = c.items || [];
          const hasBestof = c.bestofListIds && c.bestofListIds.length > 0;
          const hasMovies = items.some(i => i.itemType === 'movie');
          const hasSeries = items.some(i => i.itemType === 'series') || hasBestof;
          if (hasMovies && hasSeries) {
            allCatalogs.push({ id: c.id, type: 'movie',  name: cleanName, extra: [{ name: 'skip', isRequired: false }] });
            allCatalogs.push({ id: c.id, type: 'series', name: cleanName, extra: [{ name: 'skip', isRequired: false }] });
          } else if (hasSeries) {
            allCatalogs.push({ id: c.id, type: 'series', name: cleanName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
          } else {
            allCatalogs.push({ id: c.id, type: c.type, name: cleanName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
          }
        } else {
          allCatalogs.push({ id: c.id, type: c.type, name: cleanName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
        }
      }
    });
  } else {
    enabledDefaults.forEach(d => {
      const rawName = cfg.catalogNames && cfg.catalogNames[d.id] ? cfg.catalogNames[d.id] : d.name;
      const displayName = rawName.replace(/\s+(movies?|series|shows?)$/i, '').trim() || rawName;
      allCatalogs.push({ id: d.id, type: d.type, name: displayName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
    });
    customCatalogs.forEach(c => {
      const cleanName = (c.name || 'Custom').replace(/\s+(movies?|series|shows?)$/i, '').trim() || c.name;
      if (c.path === '_custom_items_' && (c.items || c.bestofListIds)) {
        const items = c.items || [];
        const hasBestof = c.bestofListIds && c.bestofListIds.length > 0;
        const hasMovies = items.some(i => i.itemType === 'movie');
        const hasSeries = items.some(i => i.itemType === 'series') || hasBestof;
        if (hasMovies && hasSeries) {
          allCatalogs.push({ id: c.id, type: 'movie',  name: cleanName, extra: [{ name: 'skip', isRequired: false }] });
          allCatalogs.push({ id: c.id, type: 'series', name: cleanName, extra: [{ name: 'skip', isRequired: false }] });
        } else if (hasSeries) {
          allCatalogs.push({ id: c.id, type: 'series', name: cleanName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
        } else {
          allCatalogs.push({ id: c.id, type: c.type, name: cleanName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
        }
      } else {
        allCatalogs.push({ id: c.id, type: c.type, name: cleanName, extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }] });
      }
    });
  }

  allCatalogs.push(
    { id: 'tmdb.search_movies',  type: 'movie',  name: 'Search Movies',  extra: [{ name: 'search', isRequired: true }] },
    { id: 'tmdb.search_series',  type: 'series', name: 'Search Series',  extra: [{ name: 'search', isRequired: true }] }
  );

  if (customSeasons.length > 0) {
    // Only add if not already placed via defaultCatalogOrder loop
    const alreadyAdded = allCatalogs.some(c => c.id === 'tmdb.bestof');
    if (!alreadyAdded) {
      const bestofName = (cfg.catalogNames && cfg.catalogNames['tmdb.bestof']) ? cfg.catalogNames['tmdb.bestof'] : '\u2728 Curated Lists';
      allCatalogs.push({ id: 'tmdb.bestof', type: 'series', name: bestofName, extra: [] });
    }
  }

  return {
    id:          'community.goodtaste-tmdb',
    version:     '5.0.0',
    name:        'GoodTaste',
    description: 'Curated episode lists, full TMDB metadata, catalogs, and search.',
    logo:        'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg',
    catalogs:    cfg.tmdbApiKey ? allCatalogs : [],
    resources:   ['catalog', 'meta'],
    types:       ['movie', 'series'],
    idPrefixes:  ['tmdb:', 'bestof:', 'tt'],
    behaviorHints: { configurable: true, configurationRequired: !cfg.tmdbApiKey },
    config: [
      { key: 'tmdbApiKey', type: 'text',   title: 'TMDB API Key',                                required: true  },
      { key: 'topN',       type: 'number', title: 'Top episodes in Best Of season (default: 20)', required: false },
    ],
  };
}

app.get('/manifest.json',         (req, res) => res.json(buildManifest()));
app.get('/:config/manifest.json', (req, res) => res.json(buildManifest(req.params.config)));
app.get('/',          (req, res) => res.redirect('/configure'));

// FIX: Support /:config/configure for editing an existing install
app.get('/configure', (req, res) => res.send(configurePage(null)));
app.get('/:config/configure', (req, res) => res.send(configurePage(req.params.config)));


// ─── BEST OF CATALOG ─────────────────────────────────────────────────────────
// ─── CATALOG HANDLER FUNCTIONS ───────────────────────────────────────────────
// Extracted so both /:config/ and /s/:id/:keyToken/ routes can call them directly.

async function handleBestofCatalog(cfg, req, res) {
  const apiKey = cfg.tmdbApiKey;
  if (!apiKey) return res.json({ metas: [] });
  const customSeasons = cfg.customSeasons || [];
  if (!customSeasons.length) return res.json({ metas: [] });
  try {
    const seriesCache = {};
    const metas = (await Promise.all(customSeasons.map(async function(list) {
      try {
        if (!seriesCache[list.tmdbId]) {
          seriesCache[list.tmdbId] = await getSeries(list.tmdbId, apiKey);
        }
        const series  = seriesCache[list.tmdbId];
        const prefix  = list.prefix ? list.prefix.trim() + ' ' : '';
        const label   = list.label  || 'Curated';
        const showName = series.name || series.original_name || list.tmdbName || 'Unknown';
        const epCount = (list.episodes || []).length;
        let posterUrl;
        const spec = list.posterSpec;
        if (spec && spec.mode && spec.mode !== 'default') {
          if (spec.mode === 'url' && spec.url) {
            posterUrl = spec.url;
          } else {
            posterUrl = req.protocol + '://' + req.get('host') + req.baseConfigPath + '/poster/' + list.listId + '.jpg';
          }
        } else {
          posterUrl = series.poster_path ? TMDB_IMG_MD + series.poster_path : null;
        }
        return {
          id:          'bestof:' + list.listId,
          type:        'series',
          name:        prefix + label + (showName ? ' ' + showName : ''),
          poster:      posterUrl,
          background:  series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
          description: label + ': ' + epCount + ' episode' + (epCount !== 1 ? 's' : '') + ' from ' + (showName || 'Unknown') + '.\n\n' + (series.overview || ''),
          releaseInfo: series.first_air_date ? series.first_air_date.substring(0, 4) : '',
          imdbRating:  series.vote_average ? series.vote_average.toFixed(1) : null,
          genres:      (series.genres || []).map(g => g.name),
        };
      } catch (e) { return null; }
    }))).filter(Boolean);
    res.json({ metas });
  } catch (e) {
    console.error('[bestof catalog]', e.message);
    res.json({ metas: [] });
  }
}

app.get('/:config/catalog/series/tmdb.bestof.json', async function(req, res) {
  req.baseConfigPath = '/' + req.params.config;
  handleBestofCatalog(parseConfig(req.params.config), req, res);
});

// ─── CATALOG ENDPOINT ────────────────────────────────────────────────────────
async function catalogHandler(req, res) {
  const cfg    = req.resolvedCfg || parseConfig(req.params.config);
  const type   = req.params.type;
  const id     = req.params.id;
  const apiKey = cfg.tmdbApiKey;
  if (!apiKey) return res.status(400).json({ metas: [] });

  if (id === 'tmdb.search_movies' || id === 'tmdb.search_series') {
    const extrasRaw = req.params.extras || '';
    const extrasMap = {};
    extrasRaw.split('&').forEach(part => {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) return;
      const k = decodeURIComponent(part.slice(0, eqIdx));
      const v = decodeURIComponent(part.slice(eqIdx + 1));
      if (k) extrasMap[k] = v;
    });
    const search = extrasMap.search ? extrasMap.search.trim() : null;
    if (!search) return res.json({ metas: [] });
    const page = 1;
    const tmdbType = id === 'tmdb.search_movies' ? 'movie' : 'tv';
    try {
      const data = await tmdb('/search/' + tmdbType, apiKey, { query: search, page });
      const metas = (data.results || []).map(item =>
        tmdbType === 'movie' ? movieToMeta(item) : seriesToMeta(item)
      ).filter(m => m.poster);
      return res.json({ metas });
    } catch (e) {
      return res.json({ metas: [] });
    }
  }

  const extrasRaw = req.params.extras || '';
  const extrasMap = {};
  extrasRaw.split('&').forEach(part => {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) return;
    const k = decodeURIComponent(part.slice(0, eqIdx));
    const v = decodeURIComponent(part.slice(eqIdx + 1));
    if (k) extrasMap[k] = v;
  });
  const skip   = parseInt(extrasMap.skip) || 0;
  const page   = Math.floor(skip / 20) + 1;
  const genre  = extrasMap.genre  || null;

  try {
    const defaultDef = DEFAULT_CATALOGS.find(d => d.id === id);
    const customDef  = (cfg.customCatalogs || []).find(c => c.id === id);
    const catDef     = defaultDef || customDef;
    if (!catDef) return res.json({ metas: [] });

    if (catDef.path === '_mdblist_' && catDef.mdblistUrl) {
      const listUrl = String(catDef.mdblistUrl).trim();
      const slugMatch = listUrl.match(/mdblist\.com\/(?:lists\/|@?)([^/]+)\/([^/?#]+)/);
      let ttItems = [];

      async function tryFetchMdb(fetchUrl) {
        try {
          const r = await axios.get(fetchUrl, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; GoodTaste/1.0)' },
            timeout: 15000, validateStatus: (s) => s < 500,
          });
          if (r.status !== 200) return null;
          return r;
        } catch(e) { return null; }
      }

      let resp = null;
      if (slugMatch) {
        const u = slugMatch[1], s = slugMatch[2];
        for (const c of [`https://mdblist.com/lists/${u}/${s}/json/`, `https://mdblist.com/lists/${u}/${s}.json`]) {
          resp = await tryFetchMdb(c); if (resp) break;
        }
      }
      if (!resp) {
        const stripped = listUrl.replace(/\/?$/, '');
        for (const suf of ['/json/', '.json']) {
          resp = await tryFetchMdb(stripped + suf); if (resp) break;
        }
      }

      if (resp) {
        const d = resp.data;
        ttItems = Array.isArray(d) ? d : (Array.isArray(d && d.items) ? d.items : []);
      }

      const pageItems = ttItems.slice(skip, skip + 20);
      const metas = [];
      for (const item of pageItems) {
        const imdbId     = item.imdb_id || item.imdbid || item.imdb || null;
        const itemTmdbId = item.tmdb_id || item.tmdbid || item.tmdb || null;
        const mediatype  = (item.mediatype || item.type || item.media_type || '').toLowerCase();
        const isMovie    = mediatype === 'movie' || mediatype === 'movies';
        try {
          if (itemTmdbId) {
            const d = await tmdb((isMovie ? '/movie/' : '/tv/') + itemTmdbId, apiKey);
            const meta = isMovie ? movieToMeta(d) : seriesToMeta(d);
            if (meta.poster) metas.push(meta);
          } else if (imdbId) {
            const found = await tmdb('/find/' + imdbId, apiKey, { external_source: 'imdb_id' });
            const mv = (found.movie_results || [])[0];
            const tv = (found.tv_results || [])[0];
            if (mv) { const m = movieToMeta(mv); if (m.poster) metas.push(m); }
            else if (tv) { const m = seriesToMeta(tv); if (m.poster) metas.push(m); }
          }
        } catch (e) { /* skip */ }
      }
      return res.json({ metas });
    }

    if (catDef.path === '_bestof_') {
      const customSeasons = cfg.customSeasons || [];
      // Support multiple lists in one catalog via bestofListIds array or single bestofListId
      const listIds = catDef.bestofListIds || (catDef.bestofListId ? [catDef.bestofListId] : []);
      const metas = [];
      for (const bestofListId of listIds) {
        const list = customSeasons.find(l => l.listId === bestofListId);
        if (!list || !list.episodes || !list.episodes.length) continue;
        try {
          const series = await getSeries(list.tmdbId, apiKey);
          const spec = list.posterSpec;
          let posterUrl;
          if (spec && spec.mode && spec.mode !== 'default') {
            if (spec.mode === 'url' && spec.url) posterUrl = spec.url;
            else posterUrl = req.protocol + '://' + req.get('host') + (req.baseConfigPath || ('/' + req.params.config)) + '/poster/' + list.listId + '.jpg';
          } else {
            posterUrl = series.poster_path ? TMDB_IMG_MD + series.poster_path : null;
          }
          const prefix = list.prefix ? list.prefix + ' ' : '';
          const label = list.label || 'Curated';
          const name = prefix + label + (list.tmdbName ? ' \u2014 ' + series.name : '');
          metas.push({
            id: 'bestof:' + bestofListId, type: 'series',
            name,
            poster: posterUrl,
            background: series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
            description: label + ': ' + list.episodes.length + ' episodes from ' + series.name,
            releaseInfo: series.first_air_date ? series.first_air_date.substring(0, 4) : '',
            imdbRating: series.vote_average ? series.vote_average.toFixed(1) : null,
            genres: (series.genres || []).map(g => g.name),
          });
        } catch (e) {
          console.error('[bestof catalog item]', e.message);
        }
      }
      return res.json({ metas });
    }

    if (catDef.path === '_custom_items_') {
      const items = catDef.items || [];
      // Filter by the requested type (for mixed catalogs registered under both movie+series)
      const filteredItems = items.filter(item => !item.itemType || item.itemType === type || (type === 'movie' && item.itemType === 'movie') || (type === 'series' && item.itemType === 'series'));
      const pageItems = filteredItems.slice(skip, skip + 20);
      const metas = [];
      for (const item of pageItems) {
        try {
          if (item.tmdbId && item.itemType) {
            const isMovie = item.itemType === 'movie';
            const d = await tmdb((isMovie ? '/movie/' : '/tv/') + item.tmdbId, apiKey);
            const m = isMovie ? movieToMeta(d) : seriesToMeta(d);
            if (m.poster) metas.push(m);
          }
        } catch(e) { /* skip */ }
      }
      // Also resolve bestofListIds as series entries (they are always series type)
      if (type === 'series' && catDef.bestofListIds && catDef.bestofListIds.length) {
        const customSeasons = cfg.customSeasons || [];
        for (const bestofListId of catDef.bestofListIds) {
          const list = customSeasons.find(l => l.listId === bestofListId);
          if (!list || !list.episodes || !list.episodes.length) continue;
          try {
            const series = await getSeries(list.tmdbId, apiKey);
            const spec = list.posterSpec;
            let posterUrl;
            if (spec && spec.mode && spec.mode !== 'default') {
              if (spec.mode === 'url' && spec.url) posterUrl = spec.url;
              else posterUrl = req.protocol + '://' + req.get('host') + (req.baseConfigPath || ('/' + req.params.config)) + '/poster/' + list.listId + '.jpg';
            } else {
              posterUrl = series.poster_path ? TMDB_IMG_MD + series.poster_path : null;
            }
            const prefix = list.prefix ? list.prefix + ' ' : '';
            const label = list.label || 'Curated';
            const name = prefix + label + (list.tmdbName ? ' \u2014 ' + series.name : '');
            metas.push({
              id: 'bestof:' + bestofListId, type: 'series',
              name,
              poster: posterUrl,
              background: series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
              description: label + ': ' + list.episodes.length + ' episodes from ' + series.name,
              releaseInfo: series.first_air_date ? series.first_air_date.substring(0, 4) : '',
              imdbRating: series.vote_average ? series.vote_average.toFixed(1) : null,
              genres: (series.genres || []).map(g => g.name),
            });
          } catch(e) { /* skip */ }
        }
      }
      return res.json({ metas });
    }

    if (catDef.path === '_imdblist_') {
      const listId = catDef.imdbListId;
      const imdbUrl = catDef.imdbUrl;
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
      let ttIds = [];

      if (listId) {
        try {
          const csvUrl = 'https://www.imdb.com/list/' + listId + '/export';
          const resp = await axios.get(csvUrl, {
            headers: { 'Accept': 'text/csv,text/plain,*/*', 'User-Agent': UA },
            timeout: 20000, validateStatus: (s) => s >= 200 && s < 400,
          });
          const ct = String(resp.headers && resp.headers['content-type'] || '').toLowerCase();
          if (!ct.includes('text/html')) {
            const rows = String(resp.data).split('\n');
            const header = rows[0] ? rows[0].split(',').map(h => h.replace(/"/g,'').trim().toLowerCase()) : [];
            const constIdx = header.findIndex(h => h === 'const');
            if (constIdx !== -1) {
              for (let i = 1; i < rows.length; i++) {
                const cols = rows[i].split(',');
                const ttId = String(cols[constIdx] || '').replace(/"/g,'').trim();
                if (ttId && ttId.startsWith('tt')) ttIds.push(ttId);
              }
            }
          }
        } catch(e) { /* fallback */ }
      }

      if (!ttIds.length) {
        const scrapeUrl = imdbUrl || (listId ? 'https://www.imdb.com/list/' + listId + '/' : null);
        if (scrapeUrl) {
          try {
            const resp = await axios.get(scrapeUrl, {
              headers: { 'Accept': 'text/html,*/*', 'User-Agent': UA },
              timeout: 20000, validateStatus: (s) => s >= 200 && s < 400,
            });
            const html = String(resp.data || '');
            const hrefMatches = [...html.matchAll(/\/title\/(tt\d+)\//g)].map(m => m[1]);
            ttIds = [...new Set(hrefMatches)];
          } catch(e) { /* skip */ }
        }
      }

      const pageItems = ttIds.slice(skip, skip + 20);
      const metas = [];
      for (const ttId of pageItems) {
        try {
          const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' });
          const mv = (found.movie_results || [])[0];
          const tv = (found.tv_results || [])[0];
          if (mv) { const m = movieToMeta(mv); if (m.poster) metas.push(m); }
          else if (tv) { const m = seriesToMeta(tv); if (m.poster) metas.push(m); }
        } catch(e) { /* skip */ }
      }
      return res.json({ metas });
    }

    let path   = catDef.path;
    let params = { page };
    if (genre) {
      path   = '/discover/' + (type === 'movie' ? 'movie' : 'tv');
      params = { page, with_genres: genre };
      if (id.includes('top_rated')) params.sort_by = 'vote_average.desc';
      else if (id.includes('popular') || id.includes('trending')) params.sort_by = 'popularity.desc';
    }
    if (customDef && customDef.params) Object.assign(params, customDef.params);

    const data  = await tmdb(path, apiKey, params);
    const metas = (data.results || []).map(item =>
      type === 'movie' ? movieToMeta(item) : seriesToMeta(item)
    ).filter(m => m.poster);
    res.json({ metas });
  } catch (e) {
    console.error('[catalog]', e.message);
    res.json({ metas: [] });
  }
}
app.get('/:config/catalog/:type/:id/:extras?.json', catalogHandler);

// ─── API HELPER ROUTES ────────────────────────────────────────────────────────
app.get('/api/search', async function(req, res) {
  const { q, apiKey, type = 'tv' } = req.query;
  if (!q || !apiKey) return res.json({ results: [] });
  try {
    const data = await tmdb('/search/' + type, apiKey, { query: q });
    const results = (data.results || []).slice(0, 8).map(s => {
      const isMovie = type === 'movie' || s.media_type === 'movie';
      return {
        id: s.id,
        name: isMovie ? (s.title || s.original_title) : (s.name || s.original_name),
        poster: s.poster_path ? TMDB_IMG_SM + s.poster_path : null,
        year: ((isMovie ? s.release_date : s.first_air_date) || '').substring(0, 4),
        vote_average: s.vote_average ? s.vote_average.toFixed(1) : '?',
        type: isMovie ? 'movie' : 'series',
      };
    });
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/episodes', async function(req, res) {
  const { tmdbId, apiKey } = req.query;
  if (!tmdbId || !apiKey) return res.json({ episodes: [] });
  try {
    const series   = await getSeries(tmdbId, apiKey);
    const episodes = await getAllEpisodes(tmdbId, apiKey, series.number_of_seasons || 1);
    res.json({
      show: { name: series.name, poster: series.poster_path ? TMDB_IMG_MD + series.poster_path : null, seasons: series.number_of_seasons },
      episodes,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/genres', async function(req, res) {
  const { apiKey, type = 'movie' } = req.query;
  if (!apiKey) return res.json({ genres: [] });
  try {
    const data = await tmdb('/genre/' + type + '/list', apiKey);
    res.json({ genres: data.genres || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search-multi', async function(req, res) {
  const { q, apiKey, type = 'movie' } = req.query;
  if (!q || !apiKey) return res.json({ results: [] });
  try {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const data = await tmdb('/search/' + tmdbType, apiKey, { query: q });
    const results = (data.results || []).slice(0, 10).map(s => ({
      id: s.id,
      name: tmdbType === 'movie' ? (s.title || s.original_title) : (s.name || s.original_name),
      poster: s.poster_path ? TMDB_IMG_SM + s.poster_path : null,
      year: ((tmdbType === 'movie' ? s.release_date : s.first_air_date) || '').substring(0, 4),
      vote_average: s.vote_average ? s.vote_average.toFixed(1) : '?',
      type: type,
    }));
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tmdb-search', async function(req, res) {
  const { q, apiKey, type = 'movie' } = req.query;
  if (!q || !apiKey) return res.json({ results: [] });
  try {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const data = await tmdb('/search/' + tmdbType, apiKey, { query: q });
    const results = (data.results || []).slice(0, 8).map(s => ({
      id: s.id,
      name: tmdbType === 'movie' ? (s.title || s.original_title) : (s.name || s.original_name),
      poster: s.poster_path ? TMDB_IMG_SM + s.poster_path : null,
      year: ((tmdbType === 'movie' ? s.release_date : s.first_air_date) || '').substring(0, 4),
      vote_average: s.vote_average ? s.vote_average.toFixed(1) : '?',
      overview: (s.overview || '').substring(0, 100),
    }));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hero-backdrops', async function(req, res) {
  const { apiKey } = req.query;
  if (!apiKey) return res.json({ backdrops: [] });
  try {
    const [movies, shows] = await Promise.all([
      tmdb('/trending/movie/week', apiKey),
      tmdb('/trending/tv/week', apiKey),
    ]);
    const movieBackdrops = (movies.results || []).slice(0, 10)
      .filter(m => m.backdrop_path)
      .map(m => ({ type: 'movie', name: m.title || m.original_title, backdrop: TMDB_IMG_LG + m.backdrop_path, poster: m.poster_path ? TMDB_IMG_MD + m.poster_path : null }));
    const showBackdrops = (shows.results || []).slice(0, 10)
      .filter(s => s.backdrop_path)
      .map(s => ({ type: 'series', name: s.name || s.original_name, backdrop: TMDB_IMG_LG + s.backdrop_path, poster: s.poster_path ? TMDB_IMG_MD + s.poster_path : null }));
    res.json({ backdrops: [...movieBackdrops, ...showBackdrops] });
  } catch (e) { res.status(500).json({ error: e.message, backdrops: [] }); }
});

// ─── START PAGE IMAGES: uses GOODTASTE_HERO_API_KEY env var OR user apiKey param ──
// Prefers dedicated env key; if absent, accepts an apiKey query param from the client.
// Falls back to static proxied images if neither is available.
app.get('/api/start-hero', async function(req, res) {
  const heroKey = process.env.GOODTASTE_HERO_API_KEY || process.env.TMDB_API_KEY || req.query.apiKey || null;
  if (!heroKey) {
    return res.json({ posters: [], useFallback: true });
  }
  try {
    const [movies, shows] = await Promise.all([
      tmdb('/trending/movie/week', heroKey),
      tmdb('/trending/tv/week', heroKey),
    ]);
    // 15 posters per row (row1 = movies, row2 = shows)
    const row1 = (movies.results || []).slice(0, 15)
      .filter(m => m.poster_path)
      .map(m => m.poster_path ? TMDB_IMG_MD + m.poster_path : null)
      .filter(Boolean);
    const row2 = (shows.results || []).slice(0, 15)
      .filter(s => s.poster_path)
      .map(s => s.poster_path ? TMDB_IMG_MD + s.poster_path : null)
      .filter(Boolean);
    res.json({ row1, row2, useFallback: false });
  } catch (e) {
    res.json({ posters: [], useFallback: true });
  }
});

// ─── BOOST PRESETS API ──────────────────────────────────────────────────────
app.get('/api/boosts', function(req, res) {
  res.json({ boosts: BOOST_PRESETS.map(function(b) {
    return {
      id: b.id, name: b.name, description: b.description, emoji: b.emoji,
      catalogCount: b.catalogCount, listCount: b.listCount,
      previewTmdbIds: b.previewTmdbIds || [],
    };
  })});
});

app.get('/api/boosts/:id', function(req, res) {
  const boost = BOOST_PRESETS.find(function(b) { return b.id === req.params.id; });
  if (!boost) return res.status(404).json({ error: 'Boost not found' });
  res.json({ boost });
});

app.get('/api/boost-previews', async function(req, res) {
  const { boostId, apiKey } = req.query;
  if (!boostId || !apiKey) return res.json({ posters: [] });
  const boost = BOOST_PRESETS.find(function(b) { return b.id === boostId; });
  if (!boost || !boost.previewTmdbIds || !boost.previewTmdbIds.length) return res.json({ posters: [] });
  const posters = [];
  for (const item of boost.previewTmdbIds.slice(0, 4)) {
    try {
      const endpoint = item.type === 'movie' ? '/movie/' + item.id : '/tv/' + item.id;
      const data = await tmdb(endpoint, apiKey);
      if (data.poster_path) posters.push(TMDB_IMG_MD + data.poster_path);
    } catch(e) { /* skip */ }
  }
  res.json({ posters });
});

// ─── SHARE LINK API ─────────────────────────────────────────────────────────
app.get('/api/share-encode', function(req, res) {
  const { config, shareTitle, shareDesc } = req.query;
  if (!config) return res.status(400).json({ error: 'config required' });
  try {
    const cfg = parseConfig(config);
    const shareable = Object.assign({}, cfg, { tmdbApiKey: null, _shareTitle: shareTitle || '', _shareDesc: shareDesc || '' });
    const encoded = Buffer.from(JSON.stringify(shareable)).toString('base64');
    res.json({ encoded });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SAVE CONFIG ─────────────────────────────────────────────────────────────
// Body must NOT contain tmdbApiKey — the client strips it before posting.
// Returns { id } — a short 8-char hash ID.
app.post('/api/save-config', express.json(), async function(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid config' });
  // Double-check: refuse to store any API key
  const safe = Object.assign({}, body);
  delete safe.tmdbApiKey;
  try {
    const id = await saveConfig(safe);
    res.json({ id });
  } catch(e) {
    console.error('[GoodTaste] save-config error:', e.message);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// ─── SHORT URL ROUTES (/s/:id/:keyToken/...) ─────────────────────────────────
// Resolves config from store + decodes key token, then calls the same named
// handler functions used by /:config/ routes. No redirects, no re-dispatch.

async function resolveShortRequest(id, keyToken) {
  const stored = await loadConfig(id);
  if (!stored) return null;
  const keyData = decodeKeyToken(keyToken || '');
  return Object.assign({}, stored, keyData);
}

async function injectShortConfig(req, res, next) {
  const cfg = await resolveShortRequest(req.params.sid, req.params.keyToken);
  if (!cfg) {
    if (req.path.includes('/catalog/')) return res.json({ metas: [] });
    if (req.path.includes('/meta/')) return res.json({ meta: null });
    if (req.path.includes('/episodeVideos/')) return res.json({ videos: [] });
    return res.status(404).send('Config not found');
  }
  req.resolvedCfg = cfg;
  req.baseConfigPath = '/s/' + req.params.sid + '/' + req.params.keyToken;
  req.params.config = Buffer.from(JSON.stringify(cfg)).toString('base64');
  next();
}

app.get('/s/:sid/:keyToken/manifest.json', injectShortConfig, (req, res) => res.json(buildManifest(req.params.config)));
app.get('/s/:sid/:keyToken/configure',     injectShortConfig, (req, res) => res.send(configurePage(req.params.config)));

app.get('/s/:sid/:keyToken/catalog/series/tmdb.bestof.json', injectShortConfig, (req, res) => handleBestofCatalog(req.resolvedCfg, req, res));

app.get('/s/:sid/:keyToken/catalog/:catType/:catId/:extras?.json', injectShortConfig, function(req, res) {
  req.params.type   = req.params.catType;
  req.params.id     = req.params.catId;
  catalogHandler(req, res);
});

app.get('/s/:sid/:keyToken/meta/movie/:metaId.json', injectShortConfig, function(req, res) {
  req.params.id = req.params.metaId;
  metaMovieHandler(req, res);
});

app.get('/s/:sid/:keyToken/meta/series/:metaId.json', injectShortConfig, function(req, res) {
  req.params.id = req.params.metaId;
  metaSeriesHandler(req, res);
});

app.get('/s/:sid/:keyToken/episodeVideos/series/:epId.json', injectShortConfig, function(req, res) {
  req.params.id = req.params.epId;
  episodeVideosHandler(req, res);
});

app.get('/s/:sid/:keyToken/poster/:listId.jpg', injectShortConfig, posterHandler);

// ─── SHARED CONFIG (key-free, for sharing) ───────────────────────────────────
app.get('/shared/:id/configure', async function(req, res) {
  // Support both old base64 shared links and new short IDs
  const id = req.params.id;
  let cfg = await loadConfig(id);   // short ID path
  if (cfg) return res.send(configurePage(Buffer.from(JSON.stringify(cfg)).toString('base64'), true));
  // Legacy base64
  return res.send(configurePage(id, true));
});

// Static backdrops removed — hero uses only colored placeholders until TMDB API posters load
app.get('/api/static-backdrops', function(req, res) {
  res.json({ posters: [] });
});

// Proxy a single TMDB image server-side (no API key needed, avoids hotlink blocking)
app.get('/api/proxy-img', async function(req, res) {
  const { path: imgPath } = req.query;
  if (!imgPath || !imgPath.match(/^\/[a-zA-Z0-9]+\.jpg$/)) {
    return res.status(400).send('Invalid path');
  }
  try {
    const tmdbUrl = 'https://image.tmdb.org/t/p/w342' + imgPath;
    const r = await axios.get(tmdbUrl, {
      responseType: 'arraybuffer',
      headers: {
        'Referer': 'https://www.themoviedb.org/',
        'User-Agent': 'Mozilla/5.0 (compatible; GoodTaste/1.0)',
      },
      timeout: 10000,
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(r.data));
  } catch (e) {
    res.status(404).send('Not found');
  }
});

// ─── IMDB LIST IMPORT ─────────────────────────────────────────────────────────
app.get('/api/imdb-list', async function(req, res) {
  let { url: listUrl, apiKey, tmdbId } = req.query;
  if (!listUrl || !apiKey || !tmdbId) return res.status(400).json({ error: 'url, apiKey, and tmdbId required' });

  tmdbId = String(tmdbId).replace(/^tmdb:/, '').trim();

  const listIdMatch = String(listUrl).match(/ls\d+/);
  if (!listIdMatch) return res.status(400).json({ error: 'Could not parse IMDB list ID from URL' });
  const listId = listIdMatch[0];

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  function normType(s) {
    return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') { cur += '"'; i++; continue; }
        if (ch === '"') { inQuotes = false; continue; }
        cur += ch;
        continue;
      }

      if (ch === '"') { inQuotes = true; continue; }
      if (ch === ',') { row.push(cur); cur = ''; continue; }
      if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; continue; }
      if (ch === '\r') continue;

      cur += ch;
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  async function fetchImdbCsvExport() {
    const csvUrl = 'https://www.imdb.com/list/' + listId + '/export';
    const resp = await axios.get(csvUrl, {
      headers: { 'Accept': 'text/csv,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': UA },
      timeout: 20000,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const ct = String(resp.headers && resp.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) throw new Error('IMDB export returned HTML (blocked)');
    return resp.data;
  }

  async function scrapeImdbListTtIds() {
    const pageUrl = 'https://www.imdb.com/list/' + listId + '/';
    const resp = await axios.get(pageUrl, {
      headers: { 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': UA },
      timeout: 20000,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(resp.data || '');
    const hrefMatches = [...html.matchAll(/\/title\/(tt\d+)\//g)].map(m => m[1]);
    const urlMatches = [...html.matchAll(/"url"\s*:\s*"https?:\/\/www\.imdb\.com\/title\/(tt\d+)\//g)].map(m => m[1]);
    return [...new Set([...hrefMatches, ...urlMatches])];
  }

  try {
    let csvText = null;
    try { csvText = await fetchImdbCsvExport(); } catch (e) { csvText = null; }

    let ttIds = [];
    if (csvText) {
      const rows = parseCsv(String(csvText));
      if (!rows.length) return res.json({ episodes: [], errors: [{ reason: 'Empty CSV export' }], skipped: 0 });

      const header = rows[0].map(h => String(h || '').trim().toLowerCase());
      const constIdx = header.findIndex(h => h === 'const');
      const typeIdx  = header.findIndex(h => h === 'title type');

      if (constIdx === -1) return res.status(400).json({ error: 'Unexpected CSV format — missing Const column' });

      for (let i = 1; i < rows.length; i++) {
        const cols = rows[i] || [];
        const ttId = String(cols[constIdx] || '').trim();
        const ttypeNorm = typeIdx !== -1 ? normType(cols[typeIdx]) : '';
        if (ttId && ttId.startsWith('tt') && (typeIdx === -1 || ttypeNorm === 'tvepisode')) {
          ttIds.push(ttId);
        }
      }
    } else {
      ttIds = await scrapeImdbListTtIds();
    }

    ttIds = [...new Set(ttIds)].filter(Boolean);

    if (!ttIds.length) {
      return res.json({ episodes: [], errors: [{ reason: 'No IMDb title IDs found in list' }], skipped: 0 });
    }

    const results = [];
    const errors  = [];

    for (const ttId of ttIds) {
      try {
        const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' });
        const epResults = found.tv_episode_results || [];
        if (epResults.length > 0) {
          const matches = epResults.filter(ep => String(ep.show_id) === String(tmdbId));
          if (matches.length > 0) {
            for (const ep of matches) {
              results.push({ season: ep.season_number, episode: ep.episode_number });
            }
          } else {
            errors.push({ ttId, reason: 'Episode belongs to a different show' });
          }
        } else {
          errors.push({ ttId, reason: 'Not found as TV episode on TMDB' });
        }
      } catch (e) {
        errors.push({ ttId, reason: e.message });
      }
    }

    const seen = new Set();
    const deduped = results.filter(ep => {
      const key = ep.season + ':' + ep.episode;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ episodes: deduped, errors, skipped: errors.length, totalIds: ttIds.length, matched: deduped.length, tmdbId });
  } catch (e) {
    console.error('[imdb-list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── IMDB LIST/CHART CATALOG IMPORT ──────────────────────────────────────────
app.get('/api/imdb-catalog', async function(req, res) {
  let { url: listUrl, apiKey } = req.query;
  if (!listUrl || !apiKey) return res.status(400).json({ error: 'url and apiKey required' });

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  const urlStr = String(listUrl).trim();

  const isChart = /imdb\.com\/chart\//.test(urlStr);
  const listIdMatch = urlStr.match(/ls\d+/);

  if (!isChart && !listIdMatch) {
    return res.status(400).json({ error: 'Could not parse IMDB list ID or chart URL' });
  }

  try {
    let ttIds = [];
    let listName = '';

    if (isChart) {
      const chartPath = urlStr.match(/\/chart\/[a-z]+\/?/)?.[0] || '/chart/top/';
      const chartUrl = 'https://www.imdb.com' + chartPath;
      const resp = await axios.get(chartUrl, {
        headers: { 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': UA },
        timeout: 20000, validateStatus: (s) => s >= 200 && s < 400,
      });
      const html = String(resp.data || '');
      const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
      if (titleMatch) listName = titleMatch[1].trim();
      const matches = [...html.matchAll(/\/title\/(tt\d+)\//g)].map(m => m[1]);
      ttIds = [...new Set(matches)];
      const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
      if (jsonLdMatch) {
        try {
          const jld = JSON.parse(jsonLdMatch[1]);
          const items = (jld.itemListElement || []);
          for (const item of items) {
            const u = (item.url || '') + (item.item && item.item.url || '');
            const m = u.match(/tt\d+/);
            if (m) ttIds.push(m[0]);
          }
          ttIds = [...new Set(ttIds)];
        } catch(e) { /* ignore */ }
      }
    } else {
      const listId = listIdMatch[0];
      try {
        const csvUrl = 'https://www.imdb.com/list/' + listId + '/export';
        const resp = await axios.get(csvUrl, {
          headers: { 'Accept': 'text/csv,text/plain,*/*', 'User-Agent': UA },
          timeout: 20000, validateStatus: (s) => s >= 200 && s < 400,
        });
        const ct = String(resp.headers && resp.headers['content-type'] || '').toLowerCase();
        if (!ct.includes('text/html')) {
          const text = String(resp.data || '');
          const rows = text.split('\n');
          const header = rows[0] ? rows[0].split(',').map(h => h.replace(/"/g,'').trim().toLowerCase()) : [];
          const constIdx = header.findIndex(h => h === 'const');
          if (constIdx !== -1) {
            for (let i = 1; i < rows.length; i++) {
              const cols = rows[i].split(',');
              const ttId = String(cols[constIdx] || '').replace(/"/g,'').trim();
              if (ttId && ttId.startsWith('tt')) ttIds.push(ttId);
            }
          }
        }
      } catch(e) { /* try scrape fallback */ }

      if (!ttIds.length) {
        const pageUrl = 'https://www.imdb.com/list/' + listId + '/';
        const resp = await axios.get(pageUrl, {
          headers: { 'Accept': 'text/html,*/*', 'User-Agent': UA },
          timeout: 20000, validateStatus: (s) => s >= 200 && s < 400,
        });
        const html = String(resp.data || '');
        const hrefMatches = [...html.matchAll(/\/title\/(tt\d+)\//g)].map(m => m[1]);
        ttIds = [...new Set(hrefMatches)];
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) listName = titleMatch[1].replace(/ - IMDb.*/, '').trim();
      }
    }

    ttIds = [...new Set(ttIds)].filter(Boolean).slice(0, 100);
    if (!ttIds.length) return res.json({ metas: [], count: 0, name: listName });

    const metas = [];
    for (const ttId of ttIds) {
      try {
        const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' });
        const mv = (found.movie_results || [])[0];
        const tv = (found.tv_results || [])[0];
        if (mv) { const m = movieToMeta(mv); if (m.poster) metas.push(m); }
        else if (tv) { const m = seriesToMeta(tv); if (m.poster) metas.push(m); }
      } catch(e) { /* skip */ }
    }

    res.json({ metas, count: ttIds.length, name: listName, listId: listIdMatch ? listIdMatch[0] : null, isChart });
  } catch(e) {
    console.error('[imdb-catalog]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── MDBLIST CATALOG PREVIEW ─────────────────────────────────────────────────
app.get('/api/mdblist-catalog', async function(req, res) {
  let { url: listUrl, apiKey } = req.query;
  if (!listUrl || !apiKey) return res.status(400).json({ error: 'url and apiKey required' });

  const urlStr = String(listUrl).trim();
  const slugMatch = urlStr.match(/mdblist\.com\/(?:lists\/|@?)([^/]+)\/([^/?#]+)/);

  async function tryFetch(fetchUrl) {
    const resp = await axios.get(fetchUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; GoodTaste/1.0)' },
      timeout: 15000,
      validateStatus: (s) => s < 500,
    });
    if (resp.status === 404) return null;
    return resp;
  }

  try {
    let raw = [];
    let listName = '';
    let resp = null;

    if (slugMatch) {
      const username = slugMatch[1];
      const slug = slugMatch[2];
      const candidates = [
        `https://mdblist.com/lists/${username}/${slug}/json/`,
        `https://mdblist.com/lists/${username}/${slug}.json`,
        `https://mdblist.com/@${username}/${slug}/json/`,
        `https://mdblist.com/lists/${username}/${slug}/`,
      ];
      for (const candidate of candidates) {
        resp = await tryFetch(candidate);
        if (resp && resp.status === 200) break;
        resp = null;
      }
    }

    if (!resp) {
      const stripped = urlStr.replace(/\/?$/, '');
      for (const suffix of ['/json/', '.json', '']) {
        resp = await tryFetch(stripped + suffix);
        if (resp && resp.status === 200) break;
        resp = null;
      }
    }

    if (!resp) {
      return res.status(404).json({ error: 'MDBList list not found. Make sure the URL is correct and the list is set to Public.' });
    }

    const data = resp.data;
    if (Array.isArray(data)) {
      raw = data;
    } else if (data && Array.isArray(data.items)) {
      raw = data.items;
      listName = data.name || '';
    } else if (data && Array.isArray(data.movies)) {
      raw = data.movies;
      listName = data.name || '';
    } else {
      return res.json({ metas: [], count: 0, name: '' });
    }

    if (!raw.length) return res.json({ metas: [], count: 0, name: listName });

    const metas = [];
    for (const item of raw.slice(0, 50)) {
      const imdbId     = item.imdb_id || item.imdbid || item.imdb || null;
      const itemTmdbId = item.tmdb_id || item.tmdbid || item.tmdb || null;
      const mediatype  = (item.mediatype || item.type || item.media_type || '').toLowerCase();
      const isMovie    = mediatype === 'movie' || mediatype === 'movies';
      const isTv       = mediatype === 'show' || mediatype === 'tv' || mediatype === 'series';

      try {
        if (itemTmdbId && (isMovie || isTv)) {
          const path = isMovie ? '/movie/' + itemTmdbId : '/tv/' + itemTmdbId;
          const d = await tmdb(path, apiKey);
          const m = isMovie ? movieToMeta(d) : seriesToMeta(d);
          if (m.poster) metas.push(m);
        } else if (imdbId) {
          const found = await tmdb('/find/' + imdbId, apiKey, { external_source: 'imdb_id' });
          const mv = (found.movie_results || [])[0];
          const tv = (found.tv_results || [])[0];
          if (mv) { const m = movieToMeta(mv); if (m.poster) metas.push(m); }
          else if (tv) { const m = seriesToMeta(tv); if (m.poster) metas.push(m); }
        }
      } catch (e) { /* skip unresolvable */ }
    }

    res.json({ metas, count: raw.length, name: listName });
  } catch (e) {
    console.error('[mdblist-catalog]', e.message);
    res.status(500).json({ error: 'Failed to fetch MDBList: ' + e.message });
  }
});

async function posterHandler(req, res) {
  const cfg = req.resolvedCfg || parseConfig(req.params.config);
  const listId = req.params.listId;
  const customSeasons = cfg.customSeasons || [];
  const list = customSeasons.find(l => l.listId === listId);
  if (!list) return res.status(404).send('Not found');
  if (!cfg.tmdbApiKey) return res.status(400).send('No API key');

  const spec = list.posterSpec;

  if (!spec || spec.mode === 'default' || !spec.mode) {
    try {
      const series = await getSeries(list.tmdbId, cfg.tmdbApiKey);
      if (!series.poster_path) return res.status(404).send('No poster');
      return res.redirect(TMDB_IMG_MD + series.poster_path);
    } catch(e) { return res.status(500).send('Error'); }
  }

  if (spec.mode === 'url') {
    return res.redirect(spec.url || '');
  }

  // Canvas-based poster generation
  let createCanvas, loadImage;
  let canvasAvailable = true;
  try {
    ({ createCanvas, loadImage } = require('canvas'));
  } catch(e) {
    canvasAvailable = false;
  }

  if (!canvasAvailable) {
    // canvas not installed — log clearly and fall back
    console.warn('[poster] canvas module not available. Install it with: npm install canvas');
    console.warn('[poster] Falling back to TMDB poster for list:', list.listId, '(mode:', spec.mode + ')');
    const series = await getSeries(list.tmdbId, cfg.tmdbApiKey).catch(()=>null);
    if (series && series.poster_path) return res.redirect(TMDB_IMG_MD + series.poster_path);
    return res.status(500).send('canvas module not available — install with: npm install canvas');
  }

  const W = 342, H = 513;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  if (spec.mode === 'banner') {
    try {
      const series = await getSeries(list.tmdbId, cfg.tmdbApiKey);
      if (!series.poster_path) return res.status(404).send('No poster');
      const imgResp = await axios.get(TMDB_IMG_MD + series.poster_path, { responseType: 'arraybuffer', timeout: 15000, headers: { 'Referer': 'https://www.themoviedb.org/' } });
      const img = await loadImage(Buffer.from(imgResp.data));
      ctx.drawImage(img, 0, 0, W, H);
      const barH = Math.round(H * 0.14);
      const pos = spec.pos || 'bottom';
      const barY = pos === 'top' ? 0 : H - barH;
      const barColor = spec.barColor || '#000000';
      const opacity = spec.opacity != null ? spec.opacity : 0.75;
      const textColor = spec.textColor || '#ffffff';
      const r=parseInt(barColor.slice(1,3),16), g=parseInt(barColor.slice(3,5),16), b=parseInt(barColor.slice(5,7),16);
      ctx.fillStyle=`rgba(${r},${g},${b},${opacity})`; ctx.fillRect(0,barY,W,barH);
      const label=(list.label||'Best Of');
      const fontSize=Math.round(barH*0.32);
      ctx.fillStyle=textColor; ctx.font=`600 ${fontSize}px sans-serif`;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      const maxWidth=W-24; const words=label.split(' ');
      const lines=[]; let line='';
      for(const w of words){const test=(line?line+' ':'')+w;if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=w;}else line=test;}
      if(line) lines.push(line);
      const lineH=fontSize*1.2; const totalH=lines.length*lineH;
      const startY=barY+(barH-totalH)/2+lineH/2;
      lines.forEach((l,j)=>ctx.fillText(l,W/2,startY+j*lineH));
      res.set('Content-Type','image/jpeg'); res.set('Cache-Control','public, max-age=86400');
      canvas.createJPEGStream({quality:0.9}).pipe(res);
    } catch(e) { console.error('[poster/banner]',e.message); res.status(500).send('Error'); }
    return;
  }

  if (spec.mode === 'logo') {
    try {
      const bgColor=spec.bgColor||'#111111', textColor=spec.textColor||'#ffffff';
      ctx.fillStyle=bgColor; ctx.fillRect(0,0,W,H);
      const grad=ctx.createRadialGradient(W/2,H*0.35,10,W/2,H*0.35,W*0.7);
      grad.addColorStop(0,'rgba(255,255,255,0.07)'); grad.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=grad; ctx.fillRect(0,0,W,H);
      let logoDrawn=false;
      try {
        const imgData = await tmdb('/tv/' + list.tmdbId + '/images', cfg.tmdbApiKey, { include_image_language: 'en,null' });
        const logos=(imgData.logos||[]).filter(l=>l.file_path).sort((a,b)=>(b.vote_average||0)-(a.vote_average||0));
        if (logos[0]) {
          const logoResp=await axios.get('https://image.tmdb.org/t/p/w500'+logos[0].file_path,{responseType:'arraybuffer',timeout:15000,headers:{'Referer':'https://www.themoviedb.org/'}});
          const logoImg=await loadImage(Buffer.from(logoResp.data));
          const lW=W-60,lH=Math.round(H*0.25);
          const scale=Math.min(lW/logoImg.width,lH/logoImg.height);
          const dW=logoImg.width*scale,dH=logoImg.height*scale;
          ctx.drawImage(logoImg,(W-dW)/2,(H*0.28-dH/2),dW,dH);
          logoDrawn=true;
        }
      } catch(e) { /* fall through to text */ }
      if (!logoDrawn) {
        ctx.fillStyle=textColor; ctx.font=`bold ${Math.round(W*0.09)}px sans-serif`;
        ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(list.tmdbName||'',W/2,H*0.32);
      }
      ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(40,H*0.58); ctx.lineTo(W-40,H*0.58); ctx.stroke();
      const label=list.label||'Best Of';
      ctx.fillStyle=textColor; ctx.textAlign='center'; ctx.textBaseline='middle';
      const fontSize=Math.round(W*0.065);
      ctx.font=`600 ${fontSize}px sans-serif`;
      const maxWidth=W-48; const words=label.split(' ');
      const lines=[]; let line='';
      for(const w of words){const test=(line?line+' ':'')+w;if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=w;}else line=test;}
      if(line) lines.push(line);
      const lineH=fontSize*1.35; const totalH=lines.length*lineH;
      const startY=H*0.72-totalH/2+lineH/2;
      lines.forEach((l,j)=>ctx.fillText(l,W/2,startY+j*lineH));
      res.set('Content-Type','image/jpeg'); res.set('Cache-Control','public, max-age=86400');
      canvas.createJPEGStream({quality:0.9}).pipe(res);
    } catch(e) { console.error('[poster/logo]',e.message); res.status(500).send('Error'); }
    return;
  }

  res.status(400).send('Unknown poster mode');
}
app.get('/:config/poster/:listId.jpg', posterHandler);

// ─── SERIES LOGO ENDPOINT (for poster customization) ─────────────────────────
app.get('/api/series-logo', async function(req, res) {
  const { tmdbId, apiKey } = req.query;
  if (!tmdbId || !apiKey) return res.status(400).json({ error: 'tmdbId and apiKey required' });
  try {
    const data = await tmdb('/tv/' + tmdbId + '/images', apiKey, { include_image_language: 'en,null' });
    const logos = (data.logos || []).filter(l => l.file_path);
    const best = logos.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0];
    if (best) {
      return res.json({ logoUrl: 'https://image.tmdb.org/t/p/w500' + best.file_path });
    }
    // Fallback: try series backdrop as logo source
    const seriesData = await tmdb('/tv/' + tmdbId, apiKey);
    res.json({ logoUrl: null, backdropUrl: seriesData.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + seriesData.backdrop_path : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── META ENDPOINTS ───────────────────────────────────────────────────────────
async function metaMovieHandler(req, res) {
  const cfg = req.resolvedCfg || parseConfig(req.params.config);
  let id  = req.params.id;
  if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });

  let tmdbId = null;

  if (id.startsWith('tmdb:')) {
    tmdbId = extractId(id);
  } else if (id.startsWith('tt')) {
    // IMDB ID — resolve to TMDB
    try {
      const found = await tmdb('/find/' + id, cfg.tmdbApiKey, { external_source: 'imdb_id' });
      const mv = (found.movie_results || [])[0];
      if (!mv) return res.json({ meta: null });
      tmdbId = String(mv.id);
      id = 'tmdb:' + tmdbId;
    } catch (e) {
      console.error('[movie meta tt lookup]', e.message);
      return res.json({ meta: null });
    }
  } else {
    return res.json({ meta: null });
  }

  try {
    const movie      = await getMovie(tmdbId, cfg.tmdbApiKey);
    const cert       = getMovieCert(movie);
    const director   = (movie.credits && movie.credits.crew || []).find(c => c.job === 'Director');
    const cast       = (movie.credits && movie.credits.cast || []).slice(0, 8).map(c => c.name);
    const trailerKey = (movie.videos && movie.videos.results || []).find(v => v.type === 'Trailer' && v.site === 'YouTube');
    const logo       = getBestLogo(movie.images);
    res.json({ meta: {
      id, type: 'movie', name: movie.title,
      poster: movie.poster_path ? TMDB_IMG_MD + movie.poster_path : null,
      background: movie.backdrop_path ? TMDB_IMG_LG + movie.backdrop_path : null,
      logo: logo || undefined,
      description: movie.overview,
      releaseInfo: movie.release_date ? movie.release_date.substring(0, 4) : '',
      runtime: movie.runtime ? movie.runtime + ' min' : null,
      genres: (movie.genres || []).map(g => g.name),
      imdbRating: movie.vote_average ? movie.vote_average.toFixed(1) : null,
      cast, director: director ? director.name : null, certification: cert || null,
      trailers: trailerKey ? [{ source: 'yt', type: 'Trailer', ytId: trailerKey.key }] : [],
      links: movie.external_ids && movie.external_ids.imdb_id
        ? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' + movie.external_ids.imdb_id }] : [],
    }});
  } catch (e) {
    console.error('[movie meta]', e.message);
    res.status(500).json({ err: e.message });
  }
}
app.get('/:config/meta/movie/:id.json', metaMovieHandler);

async function metaSeriesHandler(req, res) {
  const cfg = req.resolvedCfg || parseConfig(req.params.config);
  const id  = req.params.id;
  if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });

  if (id.startsWith('bestof:')) {
    const listId        = id.slice('bestof:'.length);
    const customSeasons = cfg.customSeasons || [];
    const list          = customSeasons.find(l => l.listId === listId);
    if (!list || !list.episodes || !list.episodes.length) return res.json({ meta: null });
    try {
      const series  = await getSeries(list.tmdbId, cfg.tmdbApiKey);
      const cert    = getSeriesCert(series);
      const cast    = (series.credits && series.credits.cast || []).slice(0, 8).map(c => c.name);
      const imdbId  = series.external_ids && series.external_ids.imdb_id;
      const logo    = getBestLogo(series.images);
      const allEps  = await getAllEpisodes(list.tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1);
      const bestOfEps = [];
      for (const ref of list.episodes) {
        const ep = allEps.find(e => e.season === ref.season && e.episode === ref.episode);
        if (ep) bestOfEps.push(ep);
      }
      const videos      = buildBestOfVideos(bestOfEps, imdbId, list.tmdbId);
      const startYear   = series.first_air_date ? series.first_air_date.substring(0, 4) : '';
      const endYear     = series.last_air_date   ? series.last_air_date.substring(0, 4)  : '';
      const releaseInfo = series.status === 'Ended' && endYear ? startYear + '-' + endYear : startYear;
      const prefix      = list.prefix ? list.prefix.trim() + ' ' : '';
      const label       = list.label  || 'Curated';
      const spec = list.posterSpec;
      let posterUrl;
      if (spec && spec.mode && spec.mode !== 'default') {
        if (spec.mode === 'url' && spec.url) {
          posterUrl = spec.url;
        } else {
          posterUrl = req.protocol + '://' + req.get('host') + (req.baseConfigPath || ('/' + req.params.config)) + '/poster/' + list.listId + '.jpg';
        }
      } else {
        posterUrl = series.poster_path ? TMDB_IMG_MD + series.poster_path : null;
      }
      return res.json({ meta: {
        id: 'bestof:' + listId, type: 'series',
        name:        prefix + label + (series.name ? ' ' + series.name : ''),
        poster:      posterUrl,
        background:  series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
        logo:        logo || undefined,
        description: bestOfEps.length + ' episodes \u2014 ' + label + '\n\n' + (series.overview || ''),
        releaseInfo, videos,
        runtime:       series.episode_run_time && series.episode_run_time[0] ? series.episode_run_time[0] + ' min' : null,
        genres:        (series.genres || []).map(g => g.name),
        imdbRating:    series.vote_average ? series.vote_average.toFixed(1) : null,
        cast, certification: cert || null,
        links:         imdbId ? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' + imdbId }] : [],
        behaviorHints: { defaultVideoId: null },
      }});
    } catch (e) {
      console.error('[bestof meta]', e.message);
      return res.status(500).json({ err: e.message });
    }
  }

  if (!id.startsWith('tmdb:')) {
    if (id.startsWith('tt')) {
      // IMDB ID — resolve to TMDB
      try {
        const found = await tmdb('/find/' + id, cfg.tmdbApiKey, { external_source: 'imdb_id' });
        const tv = (found.tv_results || [])[0];
        if (!tv) return res.json({ meta: null });
        id = 'tmdb:' + tv.id;
      } catch (e) {
        console.error('[series meta tt lookup]', e.message);
        return res.json({ meta: null });
      }
    } else {
      return res.json({ meta: null });
    }
  }
  const tmdbId = extractId(id);
  const topN   = parseInt(cfg.topN) || 20;
  try {
    const series = await getSeries(tmdbId, cfg.tmdbApiKey);
    const cert   = getSeriesCert(series);
    const cast   = (series.credits && series.credits.cast || []).slice(0, 8).map(c => c.name);
    const imdbId = series.external_ids && series.external_ids.imdb_id || null;
    const videos = [];

    // Build list of seasons to fetch: include season 0 (Specials) if TMDB lists it
    const seasonNums = [];
    if (series.seasons && series.seasons.some(s => s.season_number === 0 && s.episode_count > 0)) {
      seasonNums.push(0);
    }
    for (let s = 1; s <= (series.number_of_seasons || 0); s++) {
      seasonNums.push(s);
    }

    for (const s of seasonNums) {
      try {
        const season = await getSeason(tmdbId, s, cfg.tmdbApiKey);
        for (const ep of (season.episodes || [])) {
          const videoId = imdbId
            ? imdbId + ':' + s + ':' + ep.episode_number
            : id + ':' + s + ':' + ep.episode_number;
          videos.push({
            id: videoId,
            title: ep.name || 'Episode ' + ep.episode_number,
            season: s, episode: ep.episode_number,
            overview: ep.overview || '',
            thumbnail: ep.still_path ? TMDB_IMG_SM + ep.still_path : null,
            released: ep.air_date ? new Date(ep.air_date) : null,
            rating: ep.vote_average ? ep.vote_average.toFixed(1) : null,
          });
        }
      } catch (e) { /* skip broken seasons */ }
    }

    if (cfg.showAutoSeason !== false) {
      const bestOfEps = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN);
      bestOfEps.forEach((ep, i) => {
        const rank = i + 1;
        const sLabel = String(ep.season).padStart(2, '0');
        const eLabel = String(ep.episode).padStart(2, '0');
        const ratingLine = ep.vote_average > 0
          ? ep.vote_average.toFixed(1) + '/10  (' + ep.vote_count.toLocaleString() + ' votes)\n\n' : '';
        videos.push({
          id: 'tmdb:' + tmdbId + ':0:' + rank,
          title: '#' + rank + ' \u2014 S' + sLabel + 'E' + eLabel + ' \u2014 ' + ep.name,
          season: 0, episode: rank,
          overview: ratingLine + (ep.overview || ''),
          thumbnail: ep.still || null,
          released: ep.air_date ? new Date(ep.air_date) : null,
        });
      });
    }

    const startYear   = series.first_air_date ? series.first_air_date.substring(0, 4) : '';
    const endYear     = series.last_air_date   ? series.last_air_date.substring(0, 4)  : '';
    const releaseInfo = series.status === 'Ended' && endYear ? startYear + '-' + endYear : startYear;
    const logo        = getBestLogo(series.images);
    res.json({ meta: {
      id, type: 'series', name: series.name,
      poster:        series.poster_path   ? TMDB_IMG_MD + series.poster_path   : null,
      background:    series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
      logo:          logo || undefined,
      description:   series.overview, releaseInfo, videos,
      runtime:       series.episode_run_time && series.episode_run_time[0] ? series.episode_run_time[0] + ' min' : null,
      genres:        (series.genres || []).map(g => g.name),
      imdbRating:    series.vote_average ? series.vote_average.toFixed(1) : null,
      cast, certification: cert || null,
      links: imdbId ? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' + imdbId }] : [],
    }});
  } catch (e) {
    console.error('[series meta]', e.message);
    res.status(500).json({ err: e.message });
  }
}
app.get('/:config/meta/series/:id.json', metaSeriesHandler);

// ─── EPISODE VIDEOS ───────────────────────────────────────────────────────────
async function episodeVideosHandler(req, res) {
  const cfg    = req.resolvedCfg || parseConfig(req.params.config);
  const id     = req.params.id;
  if (!cfg.tmdbApiKey) return res.json({ videos: [] });
  const parts = id.split(':');
  if (parts[0] !== 'tmdb' || parts.length < 4) return res.json({ videos: [] });
  const tmdbId     = parts[1];
  const season     = parseInt(parts[2]);
  const episodeNum = parseInt(parts[3]);
  if (season !== 0) return res.json({ videos: [] });
  try {
    const series = await getSeries(tmdbId, cfg.tmdbApiKey);
    const imdbId = series.external_ids && series.external_ids.imdb_id || null;
    const topN   = parseInt(cfg.topN) || 20;
    const topEps = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN);
    const target = topEps[episodeNum - 1];
    if (!target) return res.json({ videos: [] });
    const realId = imdbId
      ? imdbId + ':' + target.season + ':' + target.episode
      : 'tmdb:' + tmdbId + ':' + target.season + ':' + target.episode;
    res.json({ videos: [{
      id:        realId,
      title:     target.name, season: target.season, episode: target.episode,
      thumbnail: target.still, overview: target.overview,
    }]});
  } catch (e) {
    console.error('[episodeVideos]', e.message);
    res.json({ videos: [] });
  }
}
app.get('/:config/episodeVideos/series/:id.json', episodeVideosHandler);

// ─── CONFIGURE PAGE ───────────────────────────────────────────────────────────
function configurePage(existingConfig, isShared) {
  const defaultCatalogsJson = JSON.stringify(DEFAULT_CATALOGS);
  // Serialize existing config to pass to client for pre-filling
  const cfg = existingConfig ? parseConfig(existingConfig) : null;
  const existingConfigJson = cfg ? JSON.stringify(cfg) : 'null';
  const shareTitle = cfg && cfg._shareTitle ? cfg._shareTitle : '';
  const shareDesc  = cfg && cfg._shareDesc  ? cfg._shareDesc  : '';

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #080808;
      --surface: #0f0f0f;
      --surface2: #161616;
      --border: #1c1c1c;
      --border2: #252525;
      --text: #e8e8e8;
      --text-dim: #888;
      --text-mute: #444;
      --gold: #f0c040;
      --gold-dim: rgba(240,192,64,0.12);
      --gold-border: rgba(240,192,64,0.25);
      --danger: #c0392b;
      --radius: 12px;
      --transition: 0.22s cubic-bezier(0.4,0,0.2,1);
    }

    html { scroll-behavior: smooth; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'DM Sans', sans-serif;
      font-weight: 400;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }

    .topbar {
      background: rgba(8,8,8,0.92);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
      padding: 0 2rem;
      height: 60px;
      display: flex;
      align-items: center;
      gap: 1rem;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .topbar-brand {
      font-family: 'Playfair Display', serif;
      font-weight: 700;
      font-size: 1.1rem;
      color: #fff;
      letter-spacing: -0.01em;
    }
    .topbar-brand span { color: var(--gold); }
    .topbar-steps {
      display: flex;
      align-items: center;
      gap: 0;
      margin-left: auto;
    }
    .step-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.72rem;
      font-weight: 500;
      color: var(--text-mute);
      padding: 4px 12px;
      border-radius: 20px;
      transition: color var(--transition);
      letter-spacing: 0.02em;
    }
    .step-pill.active { color: var(--gold); }
    .step-pill.done   { color: var(--text-dim); }
    .step-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--border2);
      transition: background var(--transition), box-shadow var(--transition);
      flex-shrink: 0;
    }
    .step-pill.active .step-dot {
      background: var(--gold);
      animation: pulse-dot 2s ease-in-out infinite;
    }
    @keyframes pulse-dot {
      0%, 100% { box-shadow: 0 0 0 0 rgba(240,192,64,0.6); }
      50% { box-shadow: 0 0 0 5px rgba(240,192,64,0); }
    }
    .step-pill.done .step-dot { background: var(--text-dim); }
    .step-divider { color: var(--text-mute); font-size: 0.6rem; opacity: 0.4; }

    @media (max-width: 600px) {
      .topbar { padding: 0 1rem; }
      .step-label { display: none; }
      .step-pill { padding: 4px 8px; }
    }

    .main { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
    @media (max-width: 600px) { .main { padding: 2rem 1rem 5rem; } }

    .page { display: none; animation: fadeUp 0.35s cubic-bezier(0.4,0,0.2,1); }
    .page.active { display: block; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .hero-bg {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      z-index: 0;
    }
    .hero-bg-row {
      position: absolute;
      left: 0; right: 0;
      display: flex;
      gap: 0;
      height: 52%;
      animation: bgScroll 38s linear infinite;
      will-change: transform;
    }
    .hero-bg-row.row2 {
      top: calc(50% + 4px);
      height: 50%;
      animation-direction: reverse;
      animation-duration: 49s;
    }
    @keyframes bgScroll {
      from { transform: translateX(0); }
      to   { transform: translateX(-50%); }
    }
    .hero-bg-item {
      flex-shrink: 0;
      height: 100%;
      width: 150px;
      padding: 0 4px;
      transform: skewX(-8deg);
    }
    .hero-bg-item img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 8px;
      opacity: 0;
      transition: opacity 1s ease;
      display: block;
    }
    .hero-bg-item img.loaded { opacity: 0.65; }
    .hero-bg-overlay {
      position: absolute;
      inset: 0;
      background: linear-gradient(
        to bottom,
        rgba(8,8,8,0.5) 0%,
        rgba(8,8,8,0.05) 25%,
        rgba(8,8,8,0.05) 75%,
        rgba(8,8,8,1) 100%
      );
      z-index: 1;
    }

    .hero-wrap {
      position: relative;
      overflow: hidden;
      border-radius: 18px;
      min-height: 420px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1rem;
      border: 1px solid var(--border);
    }
    .hero {
      position: relative;
      z-index: 2;
      text-align: center;
      padding: 3rem 2rem 2.5rem;
      width: 100%;
    }
    .hero-logo {
      font-family: 'Playfair Display', serif;
      font-size: 3.8rem;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.03em;
      margin-bottom: 0.3rem;
      line-height: 1;
    }
    .hero-logo span { color: var(--gold); }
    .hero-tagline {
      font-size: 0.85rem;
      color: rgba(255,255,255,0.6);
      margin-bottom: 2.5rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 500;
    }
    .hero-features {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      max-width: 580px;
      margin: 0 auto;
      text-align: left;
    }
    .hero-feat {
      background: rgba(15,15,15,0.75);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 0.77rem;
      color: rgba(255,255,255,0.55);
      line-height: 1.4;
    }
    .hero-feat strong {
      display: flex;
      align-items: center;
      gap: 6px;
      color: rgba(255,255,255,0.9);
      font-size: 0.8rem;
      margin-bottom: 2px;
      font-weight: 600;
    }
    .beta-inline {
      display: inline-flex;
      align-items: center;
      background: rgba(240,192,64,0.12);
      border: 1px solid rgba(240,192,64,0.3);
      color: var(--gold);
      font-size: 0.52rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      vertical-align: middle;
    }
    @media (max-width: 480px) { .hero-features { grid-template-columns: 1fr; } }

    /* Boost gallery */
    .boost-card { border:1px solid var(--border); border-radius:14px; padding:16px; margin-bottom:12px; background:var(--surface2); transition:border-color var(--transition); }
    .boost-card:hover { border-color: var(--border2); }
    .boost-card-header { display:flex; align-items:center; gap:12px; margin-bottom:8px; }
    .boost-emoji { font-size:1.6rem; flex-shrink:0; }
    .boost-info { flex:1; min-width:0; }
    .boost-name { font-size:0.92rem; font-weight:700; color:#fff; }
    .boost-meta { font-size:0.7rem; color:var(--text-mute); margin-top:2px; }
    .boost-desc { font-size:0.78rem; color:var(--text-dim); line-height:1.55; margin-bottom:10px; }
    .boost-previews { display:flex; gap:6px; margin-bottom:12px; min-height:36px; }
    .boost-preview-poster { width:42px; height:63px; border-radius:5px; object-fit:cover; flex-shrink:0; }
    .boost-btn { width:100%; }
    .boost-btn.boost-applied { background: rgba(240,192,64,0.12); color: var(--gold); border: 1px solid rgba(240,192,64,0.3); }

    .edit-mode-banner {
      background: rgba(240,192,64,0.08);
      border: 1px solid rgba(240,192,64,0.25);
      border-radius: 12px;
      padding: 12px 18px;
      margin-bottom: 1rem;
      font-size: 0.82rem;
      color: var(--gold);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .edit-mode-banner strong { font-weight: 700; }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 2rem;
      margin-bottom: 1rem;
    }
    .card-eyebrow {
      font-size: 0.68rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 0.6rem;
    }
    .card-title {
      font-family: 'Playfair Display', serif;
      font-size: 1.4rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: 0.5rem;
      letter-spacing: -0.02em;
      line-height: 1.25;
    }
    .card-sub {
      font-size: 0.82rem;
      color: var(--text-dim);
      line-height: 1.6;
      margin-bottom: 1.8rem;
    }

    .field { margin-bottom: 1.25rem; }
    label {
      display: block;
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--text-dim);
      margin-bottom: 7px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    input[type=text], input[type=number], input[type=password], textarea, select {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border2);
      border-radius: var(--radius);
      padding: 12px 15px;
      color: var(--text);
      font-size: 0.9rem;
      font-family: 'DM Sans', sans-serif;
      outline: none;
      transition: border-color var(--transition), box-shadow var(--transition);
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--gold);
      box-shadow: 0 0 0 3px var(--gold-dim);
    }
    textarea { resize: vertical; min-height: 80px; line-height: 1.5; }
    select { cursor: pointer; }
    input.error {
      border-color: var(--danger) !important;
      animation: shake 0.3s;
    }
    @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
    .hint { font-size: 0.72rem; color: var(--text-mute); margin-top: 6px; }
    .hint a { color: var(--gold); text-decoration: none; }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 11px 22px;
      border-radius: var(--radius);
      font-size: 0.87rem;
      font-weight: 600;
      font-family: 'DM Sans', sans-serif;
      cursor: pointer;
      border: none;
      transition: all var(--transition);
      letter-spacing: 0.01em;
    }
    .btn-primary { background: var(--gold); color: #000; }
    .btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
    .btn-primary:active { transform: translateY(0); }
    .btn-ghost { background: transparent; border: 1px solid var(--border2); color: var(--text-dim); }
    .btn-ghost:hover { border-color: var(--text-dim); color: var(--text); }
    .btn-danger { background: rgba(192,57,43,0.15); border: 1px solid rgba(192,57,43,0.3); color: #e05252; }
    .btn-danger:hover { background: rgba(192,57,43,0.25); }
    .btn-install {
      width: 100%;
      background: var(--gold);
      color: #000;
      font-size: 1rem;
      font-weight: 700;
      padding: 16px;
      border-radius: 14px;
      border: none;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      letter-spacing: 0.01em;
      transition: all var(--transition);
    }
    .btn-install:hover { opacity: 0.9; transform: translateY(-2px); box-shadow: 0 8px 32px rgba(240,192,64,0.25); }
    .btn-sm { padding: 7px 14px; font-size: 0.78rem; }
    .btn-lg { padding: 13px 28px; font-size: 0.95rem; }

    .toggle { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute;
      inset: 0;
      background: var(--border2);
      border-radius: 22px;
      transition: background 0.2s;
      cursor: pointer;
    }
    .toggle-slider::before {
      content: '';
      position: absolute;
      width: 16px; height: 16px;
      left: 3px; top: 3px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.2s;
    }
    .toggle input:checked + .toggle-slider { background: var(--gold); }
    .toggle input:checked + .toggle-slider::before { transform: translateX(18px); }

    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .section-label { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-mute); }

    .search-wrap { position: relative; }
    .search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--text-mute); pointer-events: none; font-size: 0.85rem; }
    .search-wrap input { padding-left: 42px; }
    .search-results { margin-top: 8px; display: none; }
    .search-results.visible { display: block; }
    .search-result-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; cursor: pointer; transition: background var(--transition); border: 1px solid transparent; }
    .search-result-item:hover { background: var(--surface2); border-color: var(--border); }
    .search-poster { width: 34px; height: 50px; border-radius: 5px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }
    .search-name { font-size: 0.87rem; font-weight: 600; color: var(--text); }
    .search-meta { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }

    .show-card { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; margin-bottom: 10px; background: var(--surface2); transition: border-color var(--transition); }
    .show-card:hover { border-color: var(--border2); }
    .show-card-header { display: flex; align-items: center; gap: 14px; padding: 14px 16px; }
    .show-poster { width: 32px; height: 48px; border-radius: 5px; object-fit: cover; background: var(--surface); flex-shrink: 0; }
    .show-card-info { flex: 1; min-width: 0; }
    .show-card-name { font-size: 0.88rem; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .show-card-sub { font-size: 0.71rem; color: var(--text-mute); margin-top: 2px; }
    .show-card-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .ep-count-badge { font-size: 0.7rem; color: var(--text-mute); font-family: 'DM Mono', monospace; background: var(--surface); border: 1px solid var(--border); padding: 3px 8px; border-radius: 20px; }
    .ep-count-badge.has-eps { color: var(--gold); border-color: var(--gold-border); background: var(--gold-dim); }

    .show-ep-body { display: none; border-top: 1px solid var(--border); }
    .show-card.expanded .show-ep-body { display: block; }
    .show-ep-inner { padding: 12px 16px 16px; }

    .show-rename-row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
    .show-rename-prefix { max-width: 70px; font-size: 1.1rem; text-align: center; padding: 9px 10px; }
    .show-rename-label { flex: 1; }

    .poster-customizer { border: 1px solid var(--border); border-radius: 10px; background: var(--bg); padding: 12px 14px; margin-bottom: 14px; }
    .poster-customizer-label { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-mute); margin-bottom: 8px; }
    .poster-mode-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
    .poster-mode-tab { padding: 5px 10px; font-size: 0.72rem; font-weight: 600; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text-mute); cursor: pointer; font-family: 'DM Sans', sans-serif; transition: all var(--transition); }
    .poster-mode-tab.active { border-color: var(--gold); color: var(--gold); background: var(--gold-dim); }
    .poster-mode-tab:hover:not(.active) { border-color: var(--border2); color: var(--text-dim); }
    .poster-mode-panel { display: none; }
    .poster-mode-panel.active { display: block; }
    .poster-options-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
    .poster-opt-field { display: flex; flex-direction: column; gap: 4px; }
    .poster-opt-field label { font-size: 0.68rem; color: var(--text-mute); white-space: nowrap; }
    .poster-opt-field input[type=color] { width: 36px; height: 28px; border: 1px solid var(--border); border-radius: 5px; background: transparent; cursor: pointer; padding: 2px; }
    .poster-opt-field input[type=range] { width: 90px; }
    .poster-opt-field select { font-size: 0.75rem; padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); }

    .add-tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--surface); }
    .add-tab { flex: 1; padding: 9px 8px; font-size: 0.73rem; font-weight: 600; text-align: center; cursor: pointer; color: var(--text-mute); background: transparent; border: none; font-family: 'DM Sans', sans-serif; transition: all var(--transition); border-bottom: 2px solid transparent; letter-spacing: 0.03em; }
    .add-tab.active { color: var(--gold); border-bottom-color: var(--gold); }
    .add-tab:hover:not(.active) { color: var(--text-dim); }
    .add-panel { display: none; padding: 14px; background: var(--surface); }
    .add-panel.active { display: block; }

    .paste-hint { font-size: 0.72rem; color: var(--text-mute); margin-bottom: 8px; line-height: 1.5; }
    .paste-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
    .paste-status { font-size: 0.73rem; }
    .paste-status.ok  { color: #4caf82; }
    .paste-status.err { color: #e05252; }

    .import-row { display: flex; gap: 8px; }
    .import-row input { flex: 1; font-size: 0.82rem; }
    .import-status { font-size: 0.73rem; margin-top: 6px; color: var(--text-mute); min-height: 18px; }
    .import-status.ok  { color: #4caf82; }
    .import-status.err { color: #e05252; }

    .ep-list { list-style: none; }
    .ep-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; margin-bottom: 5px; background: var(--bg); border: 1px solid var(--border); touch-action: none; user-select: none; transition: border-color var(--transition), opacity var(--transition); -webkit-user-select: none; }
    .ep-item.dragging  { opacity: 0.4; }
    .ep-item.drag-over { border-color: var(--gold); background: var(--gold-dim); }
    .ep-rank { width: 22px; text-align: center; flex-shrink: 0; font-size: 0.68rem; color: var(--text-mute); font-family: 'DM Mono', monospace; }
    .ep-drag { color: var(--text-mute); flex-shrink: 0; font-size: 0.85rem; cursor: grab; padding: 4px; touch-action: none; }
    .ep-thumb { width: 56px; height: 32px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: var(--surface2); }
    .ep-info  { flex: 1; min-width: 0; }
    .ep-label { font-size: 0.79rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ep-sublabel { font-size: 0.67rem; color: var(--text-mute); margin-top: 2px; }
    .ep-rating { font-size: 0.7rem; color: var(--gold); font-family: 'DM Mono', monospace; flex-shrink: 0; }
    .ep-del { flex-shrink: 0; color: var(--text-mute); cursor: pointer; font-size: 0.9rem; padding: 4px 5px; border-radius: 5px; transition: color var(--transition); }
    .ep-del:hover { color: #e05252; }
    .ep-list-empty { font-size: 0.8rem; color: var(--text-mute); padding: 10px 0; }
    .ep-list-actions { display: flex; gap: 8px; margin-top: 12px; }

    .catalog-row { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 8px; }
    .catalog-row-info { flex: 1; min-width: 0; }
    .catalog-row-name-input { background: transparent; border: none; border-bottom: 1px solid transparent; border-radius: 0; padding: 2px 0; font-size: 0.87rem; font-weight: 600; color: var(--text); width: 100%; font-family: 'DM Sans', sans-serif; transition: border-color var(--transition); }
    .catalog-row-name-input:focus { outline: none; border-bottom-color: var(--gold); box-shadow: none; }
    .catalog-row-type { font-size: 0.7rem; color: var(--text-mute); margin-top: 2px; }
    .catalog-section-label { font-size: 0.68rem; font-weight: 600; color: var(--text-mute); text-transform: uppercase; letter-spacing: 0.1em; margin: 16px 0 8px; }

    .catalog-row-custom { flex-wrap: wrap; }
    .catalog-row-custom.expanded { border-color: var(--gold-border); border-radius: 10px 10px 0 0; border-bottom: none; }
    .custom-catalog-editor { display: none; width: 100%; border: 1px solid var(--gold-border); border-top: 1px solid var(--border); padding: 12px 14px 14px; background: var(--bg); border-radius: 0 0 10px 10px; overflow: hidden; }
    .catalog-row-custom.expanded .custom-catalog-editor { display: block; }
    .cat-items-list { list-style: none; margin: 6px 0 10px; }
    .cat-item-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 5px; }
    .cat-item-poster { width: 28px; height: 42px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: var(--surface); }
    .cat-item-info { flex: 1; min-width: 0; overflow: hidden; }
    .cat-item-name { font-size: 0.8rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cat-item-sub  { font-size: 0.68rem; color: var(--text-mute); margin-top: 1px; }
    .cat-item-drag { color: var(--text-mute); font-size: 0.85rem; cursor: grab; padding: 4px; touch-action: none; flex-shrink: 0; }
    .cat-item-del  { color: var(--text-mute); cursor: pointer; padding: 4px 5px; border-radius: 4px; flex-shrink: 0; font-size: 0.9rem; }
    .cat-item-del:hover { color: #e05252; }
    .cat-item-row.dragging { opacity: 0.35; }
    .cat-item-row.drag-over-item { border-color: var(--gold); background: var(--gold-dim); }

    .cat-search-result { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; cursor: pointer; transition: background var(--transition); }
    .cat-search-result:hover:not(.cat-search-added) { background: var(--surface2); }
    .cat-search-result.cat-search-added { opacity: 0.6; cursor: default; }
    .cat-search-result-poster { width: 28px; height: 42px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: var(--surface2); }

    .cc-step { display: none; }
    .cc-step.active { display: block; }

    .catalog-row.dragging-def { opacity: 0.35; }
    .catalog-row.drag-over-def { border-color: var(--gold); background: var(--gold-dim); }
    .catalog-drag-handle { color: var(--text-mute); font-size: 0.95rem; cursor: grab; padding: 4px 8px 4px 0; flex-shrink: 0; touch-action: none; }

    .add-cat-tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 14px; overflow-x: auto; }
    .add-cat-tab { flex: 1; padding: 8px 6px; font-size: 0.72rem; font-weight: 600; text-align: center; cursor: pointer; color: var(--text-mute); background: transparent; border: none; font-family: 'DM Sans', sans-serif; transition: all var(--transition); border-bottom: 2px solid transparent; letter-spacing: 0.03em; }
    .add-cat-tab.active { color: var(--gold); border-bottom-color: var(--gold); }
    .add-cat-panel { display: none; }
    .add-cat-panel.active { display: block; }

    .szero-card { background: rgba(240,192,64,0.03); border: 1px solid rgba(240,192,64,0.12); border-radius: 14px; padding: 14px 18px; margin-bottom: 1rem; }
    .szero-header { display: flex; align-items: center; gap: 12px; justify-content: space-between; cursor: pointer; }
    .szero-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .szero-title-row { display: flex; align-items: center; gap: 8px; }
    .szero-title-text { font-size: 0.88rem; font-weight: 600; color: var(--text); }
    .beta-badge { display: inline-flex; align-items: center; background: rgba(240,192,64,0.1); border: 1px solid rgba(240,192,64,0.3); color: var(--gold); font-size: 0.55rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 5px; border-radius: 3px; }
    .szero-desc { font-size: 0.75rem; color: var(--text-mute); margin-top: 2px; line-height: 1.5; }
    .szero-body { margin-top: 14px; padding-top: 14px; border-top: 1px solid rgba(240,192,64,0.1); display: none; }
    .szero-card.expanded .szero-body { display: block; }
    .szero-expand-icon { color: var(--text-mute); font-size: 0.8rem; transition: transform var(--transition); flex-shrink: 0; }
    .szero-card.expanded .szero-expand-icon { transform: rotate(180deg); }
    .szero-warning { font-size: 0.75rem; color: rgba(240,192,64,0.7); background: rgba(240,192,64,0.05); border: 1px solid rgba(240,192,64,0.1); border-radius: 8px; padding: 10px 12px; margin-top: 12px; line-height: 1.5; }

    .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8); backdrop-filter: blur(4px); z-index: 500; align-items: center; justify-content: center; padding: 1.5rem; }
    .modal-backdrop.open { display: flex; }
    .modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 20px; max-width: 580px; width: 100%; max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; animation: modalIn 0.25s cubic-bezier(0.4,0,0.2,1); }
    @keyframes modalIn { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
    .modal-header { padding: 1.4rem 1.6rem 1rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 14px; }
    .modal-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }
    .modal-title  { font-size: 1rem; font-weight: 700; color: #fff; }
    .modal-sub    { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }
    .modal-close  { margin-left: auto; color: var(--text-mute); cursor: pointer; font-size: 1.2rem; padding: 4px; }
    .modal-close:hover { color: var(--text); }
    .modal-filter { padding: 12px 1.6rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .season-btn { padding: 4px 12px; border-radius: 20px; font-size: 0.72rem; font-weight: 600; background: var(--surface2); border: 1px solid var(--border); color: var(--text-mute); cursor: pointer; transition: all var(--transition); }
    .season-btn.active { background: var(--gold); border-color: var(--gold); color: #000; }
    .modal-ep-list { flex: 1; overflow-y: auto; padding: 10px 1.6rem; }
    .modal-ep-item { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 10px; margin-bottom: 4px; cursor: pointer; transition: background var(--transition); border: 1.5px solid transparent; }
    .modal-ep-item:hover { background: var(--surface2); }
    .modal-ep-item.selected { border-color: var(--gold); background: var(--gold-dim); }
    .modal-ep-thumb { width: 64px; height: 36px; border-radius: 5px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }
    .modal-ep-info  { flex: 1; min-width: 0; }
    .modal-ep-name  { font-size: 0.82rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .modal-ep-meta  { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; }
    .modal-ep-check { width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(--border2); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; transition: all var(--transition); }
    .modal-ep-item.selected .modal-ep-check { background: var(--gold); border-color: var(--gold); color: #000; }
    .modal-footer { padding: 1rem 1.6rem; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .modal-sel-label { font-size: 0.8rem; color: var(--text-dim); }

    .install-hero { text-align: center; padding: 1rem 0 2rem; }
    .install-hero-title { font-family: 'Playfair Display', serif; font-size: 2rem; font-weight: 700; color: #fff; margin-bottom: 6px; letter-spacing: -0.02em; }
    .install-hero-title span { color: var(--gold); font-style: italic; }
    .install-hero-sub { font-size: 0.83rem; color: var(--text-dim); }

    .summary-row { display: flex; align-items: center; justify-content: space-between; padding: 11px 14px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 8px; font-size: 0.82rem; }
    .summary-label { color: var(--text-dim); }
    .summary-value { color: #fff; font-weight: 600; font-family: 'DM Mono', monospace; font-size: 0.78rem; }
    .summary-value.accent { color: var(--gold); }

    .ep-parade { display: flex; gap: 6px; overflow: hidden; margin: 1.5rem 0; mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent); -webkit-mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent); }
    .ep-parade-track { display: flex; gap: 6px; animation: scroll 30s linear infinite; flex-shrink: 0; }
    @keyframes scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
    .parade-thumb { width: 80px; height: 45px; border-radius: 6px; object-fit: cover; flex-shrink: 0; opacity: 0.7; }
    .parade-thumb.no-img { background: var(--surface2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 1.2rem; }

    .or-divider { text-align: center; font-size: 0.72rem; color: var(--text-mute); margin: 14px 0 12px; }
    .copy-row { display: flex; gap: 8px; }
    .copy-row input { flex: 1; font-size: 0.72rem; color: var(--text-mute); padding: 10px 12px; font-family: 'DM Mono', monospace; }
    .btn-copy { flex-shrink: 0; padding: 10px 18px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius); color: var(--text-dim); font-size: 0.78rem; font-weight: 600; cursor: pointer; transition: all var(--transition); font-family: 'DM Sans', sans-serif; }
    .btn-copy:hover  { border-color: var(--gold); color: var(--gold); }
    .btn-copy.copied { border-color: #4caf82; color: #4caf82; }

    .nav-row { display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; }

    .spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(0,0,0,0.2); border-top-color: rgba(0,0,0,0.7); border-radius: 50%; animation: spin 0.7s linear infinite; }
    .spinner-light { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,0.2); border-top-color: rgba(255,255,255,0.8); border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-state { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 2rem; font-size: 0.82rem; color: var(--text-mute); }

    .empty-state { text-align: center; padding: 2.5rem 1rem; color: var(--text-mute); font-size: 0.82rem; }

    .flex-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .mt-1 { margin-top: 8px; }
    .mt-2 { margin-top: 14px; }

    .custom-catalog-form { background: var(--surface2); border: 1px solid var(--border2); border-radius: 14px; padding: 16px; margin-top: 12px; display: none; }
    .custom-catalog-form.open { display: block; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    @media (max-width: 480px) { .form-row { grid-template-columns: 1fr; } }
  `;

  const clientJS = [
    "var DEFAULT_CATALOGS = " + defaultCatalogsJson + ";",
    "var EXISTING_CONFIG = " + existingConfigJson + ";",
    "var state = {",
    "  apiKey: '', topN: 20, showAutoSeason: false,",
    "  customSeasons: [], catalogEnabled: {}, catalogNames: {}, customCatalogs: [], defaultCatalogOrder: null",
    "};",
    "var modalData = { listId: null, tmdbId: null, allEpisodes: [], filteredSeason: 'all', selected: new Set() };",
    "var genreCache = { movie: null, tv: null };",
    "var TOTAL_PAGES = 5;",
    "var isEditMode = !!EXISTING_CONFIG;",
    "var boostApplied = false;",
    "",

    // ── Pre-fill from existing config ──
    "function loadExistingConfig() {",
    "  if (!EXISTING_CONFIG) return;",
    "  var cfg = EXISTING_CONFIG;",
    "  state.apiKey = cfg.tmdbApiKey || '';",
    "  state.topN = cfg.topN || 20;",
    "  state.showAutoSeason = !!cfg.showAutoSeason;",
    "  state.customSeasons = cfg.customSeasons || [];",
    "  state.catalogEnabled = cfg.catalogEnabled || {};",
    "  state.catalogNames = cfg.catalogNames || {};",
    "  state.customCatalogs = cfg.customCatalogs || [];",
    "  state.unifiedOrder = cfg.defaultCatalogOrder || null;",
    "  // Pre-fill the API key input",
    "  var inp = document.getElementById('apiKey');",
    "  if (inp) inp.value = state.apiKey;",
    "  // Pre-fill topN and showAutoSeason",
    "  var topNInp = document.getElementById('topN');",
    "  if (topNInp) topNInp.value = state.topN;",
    "  var szeroChk = document.getElementById('showAutoSeason');",
    "  if (szeroChk) szeroChk.checked = state.showAutoSeason;",
    "  // Always render lists and catalogs so shared config shows them",
    "  renderDefaultCatalogs();",
    "  renderCustomSeasonsList();",
    "  // If we have an API key, stay on page 1 and enrich",
    "  if (state.apiKey) {",
    "    goTo(1);",
    "    // Enrich episodes with thumbnails in the background",
    "    enrichAllEpisodeThumbnails();",
    "    // Refresh hero with real TMDB posters using user key",
    "    refreshHeroWithApiKey(state.apiKey);",
    "  }",
    "  // Always load boost gallery so it's ready (for edit/share mode)",
    "  loadBoostGallery();",
    "}",
    "",
    "// After loading existing config, fetch episode stills for all shows so thumbnails display",
    "async function enrichAllEpisodeThumbnails() {",
    "  if (!state.customSeasons.length || !state.apiKey) return;",
    "  // Group lists by tmdbId so we only fetch each show once",
    "  var byShow = {};",
    "  state.customSeasons.forEach(function(list) {",
    "    if (!byShow[list.tmdbId]) byShow[list.tmdbId] = [];",
    "    byShow[list.tmdbId].push(list);",
    "  });",
    "  for (var tmdbId in byShow) {",
    "    try {",
    "      var r = await fetch('/api/episodes?tmdbId=' + tmdbId + '&apiKey=' + encodeURIComponent(state.apiKey));",
    "      var d = await r.json();",
    "      if (!d.episodes || !d.episodes.length) continue;",
    "      // Build a lookup map: 'season:episode' -> full episode data",
    "      var epMap = {};",
    "      d.episodes.forEach(function(ep) { epMap[ep.season + ':' + ep.episode] = ep; });",
    "      // Enrich each list for this show",
    "      byShow[tmdbId].forEach(function(list) {",
    "        // Also update the name and poster if not stored",
    "        if (!list.tmdbName && d.show && d.show.name) list.tmdbName = d.show.name;",
    "        if (!list.tmdbPoster && d.show && d.show.poster) list.tmdbPoster = d.show.poster;",
    "        list.episodes = list.episodes.map(function(ep) {",
    "          var key = ep.season + ':' + ep.episode;",
    "          var full = epMap[key];",
    "          if (full) {",
    "            return {",
    "              season: ep.season, episode: ep.episode,",
    "              name: full.name || ep.name,",
    "              overview: full.overview || ep.overview || '',",
    "              still: full.still || ep.still || null,",
    "              vote_average: full.vote_average || ep.vote_average || 0,",
    "              vote_count: full.vote_count || ep.vote_count || 0,",
    "              air_date: full.air_date || ep.air_date || '',",
    "            };",
    "          }",
    "          return ep;",
    "        });",
    "        // Re-render this list's episodes now that we have stills",
    "        renderListEpisodes(list.listId);",
    "      });",
    "    } catch(e) { /* skip show on error */ }",
    "  }",
    "  // Re-render list cards to show enriched names and posters",
    "  renderCustomSeasonsList();",
    "}",
    "",

    "function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }",
    "",

    "function goTo(n) {",
    "  document.querySelectorAll('.page').forEach(function(p,i){ p.classList.toggle('active', i+1===n); });",
    "  document.querySelectorAll('[id^=step-]').forEach(function(el) {",
    "    var num = parseInt(el.id.replace('step-',''));",
    "    el.classList.remove('active','done');",
    "    if (num===n) el.classList.add('active');",
    "    else if (num<n) el.classList.add('done');",
    "  });",
    "  if (n===TOTAL_PAGES) buildInstallPage();",
    "  if (n===2) loadBoostGallery();",
    "  if (n===3) renderCustomSeasonsList();",
    "  if (n===4) { renderUnifiedCatalogList(); renderBestOfCatalogPicker(); }",
    "  window.scrollTo({top:0,behavior:'smooth'});",
    "}",
    "",

    // ── Hero background — uses dedicated GOODTASTE_HERO_API_KEY if set, otherwise user key ──
    // Loads from /api/start-hero. Falls back to static proxied images then colored boxes.
    "async function loadHeroBackgrounds() {",
    "  var row1 = document.getElementById('hero-bg-row1');",
    "  var row2 = document.getElementById('hero-bg-row2');",
    "  if (!row1 || !row2) return;",
    "  // Show colored placeholder boxes immediately",
    "  function showColorBoxes() {",
    "    var colors1=['#1a1a2e','#16213e','#0f3460','#533483','#2b2d42','#1e1e2e','#1b262c','#0a3d62'];",
    "    var colors2=['#2c3e50','#1a1a2e','#4a235a','#0d2137','#1b1b2f','#162032','#1e2d40','#2a1a3e'];",
    "    function makeBoxRow(colors) {",
    "      return colors.concat(colors).map(function(c){",
    "        return '<div class=\"hero-bg-item\"><div style=\"width:100%;height:100%;background:'+c+';border-radius:8px;opacity:0.7\"></div></div>';",
    "      }).join('');",
    "    }",
    "    row1.innerHTML = makeBoxRow(colors1);",
    "    row2.innerHTML = makeBoxRow(colors2);",
    "  }",
    "  showColorBoxes();",
    "  // Try to load real posters — use user API key if available",
    "  var apiKeyParam = state.apiKey ? '&apiKey=' + encodeURIComponent(state.apiKey) : '';",
    "  try {",
    "    var r = await fetch('/api/start-hero?_t=' + Date.now() + apiKeyParam);",
    "    var d = await r.json();",
    "    if (!d.useFallback && d.row1 && d.row1.length >= 4) {",
    "      function makeFromPosters(arr) {",
    "        return arr.concat(arr).map(function(src) {",
    "          return '<div class=\"hero-bg-item\"><img src=\"' + src + '\" alt=\"\" onload=\"this.classList.add(\\'loaded\\')\"/></div>';",
    "        }).join('');",
    "      }",
    "      row1.innerHTML = makeFromPosters(d.row1);",
    "      row2.innerHTML = makeFromPosters(d.row2 && d.row2.length ? d.row2 : d.row1);",
    "      return;",
    "    }",
    "  } catch(e) { /* silent fail — color boxes remain */ }",
    "}",
    "",
    // refreshHeroWithApiKey: now called after API key is validated to reload hero with real posters
    "async function refreshHeroWithApiKey(apiKey) {",
    "  state.apiKey = apiKey;",
    "  await loadHeroBackgrounds();",
    "}",
    "",

    // ── API key validation ──
    "async function validateApiKey() {",
    "  var input = document.getElementById('apiKey');",
    "  var key = input.value.trim();",
    "  var btn = document.getElementById('btn-validate');",
    "  if (!key) { flashError(input); return; }",
    "  btn.innerHTML = '<span class=\"spinner\"></span> Checking...';",
    "  btn.disabled = true;",
    "  try {",
    "    var r = await fetch('/api/search?q=test&apiKey='+encodeURIComponent(key));",
    "    var d = await r.json();",
    "    if (d.error) throw new Error(d.error);",
    "    state.apiKey = key;",
    "    refreshHeroWithApiKey(key);",
    "    renderDefaultCatalogs();",
    "    // If we have custom seasons (e.g. loaded from a shared link), enrich episode thumbnails now",
    "    if (state.customSeasons.length) enrichAllEpisodeThumbnails();",
    "    goTo(2);",
    "  } catch(e) {",
    "    flashError(input);",
    "    input.placeholder = 'Invalid key \u2014 try again';",
    "  } finally { btn.innerHTML = 'Continue &rarr;'; btn.disabled = false; }",
    "}",
    "",
    "function flashError(el) { el.classList.add('error'); el.focus(); setTimeout(function(){ el.classList.remove('error'); },2000); }",
    "",

    "function switchAddTab(listId, tab) {",
    "  ['picker','imdb','paste'].forEach(function(t) {",
    "    var btn = document.getElementById('add-tab-'+t+'-'+listId);",
    "    var panel = document.getElementById('add-panel-'+t+'-'+listId);",
    "    if (btn) btn.classList.toggle('active', t===tab);",
    "    if (panel) panel.classList.toggle('active', t===tab);",
    "  });",
    "}",
    "",

    "function parsePasteEpisodes(text) {",
    "  var results = [];",
    "  var re = /[Ss](\\d{1,3})[Ee](\\d{1,3})|(?:^|\\D)(\\d{1,2})[Xx](\\d{1,3})(?:\\D|$)/gm;",
    "  var m;",
    "  while ((m = re.exec(text)) !== null) {",
    "    var s = parseInt(m[1]||m[3]); var e = parseInt(m[2]||m[4]);",
    "    if (!isNaN(s)&&!isNaN(e)&&s>0&&e>0) results.push({season:s,episode:e});",
    "  }",
    "  var seen = new Set();",
    "  return results.filter(function(ep){ var k=ep.season+':'+ep.episode; if(seen.has(k)) return false; seen.add(k); return true; });",
    "}",
    "",

    "function applyPaste(listId) {",
    "  var ta = document.getElementById('paste-input-'+listId);",
    "  var st = document.getElementById('paste-status-'+listId);",
    "  if (!ta||!st) return;",
    "  var text = ta.value.trim();",
    "  if (!text) { st.textContent='Paste some episode codes first'; st.className='paste-status err'; return; }",
    "  var parsed = parsePasteEpisodes(text);",
    "  if (!parsed.length) { st.textContent='No codes found. Use S01E01 or 1x01 format.'; st.className='paste-status err'; return; }",
    "  var list = getList(listId); if (!list) return;",
    "  var allEps = (modalData.tmdbId===list.tmdbId) ? modalData.allEpisodes : [];",
    "  var existingKeys = new Set(list.episodes.map(function(e){ return e.season+':'+e.episode; }));",
    "  var added=0;",
    "  for (var i=0;i<parsed.length;i++) {",
    "    var ref=parsed[i]; var key=ref.season+':'+ref.episode;",
    "    if (!existingKeys.has(key)) {",
    "      existingKeys.add(key);",
    "      var full=allEps.find(function(e){ return e.season===ref.season&&e.episode===ref.episode; });",
    "      list.episodes.push(full||ref); added++;",
    "    }",
    "  }",
    "  st.textContent='Added '+added+' of '+parsed.length+' episode'+(parsed.length!==1?'s':'')+' (dupes skipped)';",
    "  st.className='paste-status ok';",
    "  ta.value='';",
    "  renderListEpisodes(listId);",
    "  updateEpCount(listId);",
    "}",
    "",

    "function initUnifiedOrder() {",
    "  if (!state.unifiedOrder) {",
    "    state.unifiedOrder = DEFAULT_CATALOGS.map(function(c){ return {kind:'default',id:c.id}; });",
    "  }",
    "}",
    "function renderDefaultCatalogs() { renderUnifiedCatalogList(); }",
    "function renderCustomCatalogsList() { renderUnifiedCatalogList(); }",
    "// syncListCatalogs: no-op — curated lists appear via the tmdb.bestof catalog, not individual catalogs",
    "function syncListCatalogs() {",
    "  // Remove any stale auto-created per-list catalogs that may have been created by older versions",
    "  state.customCatalogs = state.customCatalogs.filter(function(c) { return !c._autoList; });",
    "  // Clean up unifiedOrder entries pointing to removed auto catalogs",
    "  state.unifiedOrder && (state.unifiedOrder = state.unifiedOrder.filter(function(o) {",
    "    if (o.kind !== 'custom') return true;",
    "    return !!state.customCatalogs.find(function(c){ return c.id === o.id; });",
    "  }));",
    "}",
    "function renderUnifiedCatalogList() {",
    "  syncListCatalogs();",
    "  initUnifiedOrder();",
    "  // Ensure the bestof sentinel entry is present when there are curated lists",
    "  if (state.customSeasons.length > 0) {",
    "    if (!state.unifiedOrder.find(function(o){ return o.kind==='bestof'&&o.id==='tmdb.bestof'; })) {",
    "      state.unifiedOrder.unshift({kind:'bestof',id:'tmdb.bestof'});",
    "    }",
    "  } else {",
    "    state.unifiedOrder = state.unifiedOrder.filter(function(o){ return !(o.kind==='bestof'&&o.id==='tmdb.bestof'); });",
    "  }",
    "  DEFAULT_CATALOGS.forEach(function(c) {",
    "    if (!state.unifiedOrder.find(function(o){ return o.kind==='default'&&o.id===c.id; })) {",
    "      state.unifiedOrder.push({kind:'default',id:c.id});",
    "    }",
    "  });",
    "  state.customCatalogs.forEach(function(c) {",
    "    if (!state.unifiedOrder.find(function(o){ return o.kind==='custom'&&o.id===c.id; })) {",
    "      state.unifiedOrder.push({kind:'custom',id:c.id});",
    "    }",
    "  });",
    "  state.unifiedOrder = state.unifiedOrder.filter(function(o) {",
    "    if (o.kind==='bestof') return state.customSeasons.length > 0;",
    "    if (o.kind==='default') return !!DEFAULT_CATALOGS.find(function(c){ return c.id===o.id; });",
    "    return !!state.customCatalogs.find(function(c){ return c.id===o.id; });",
    "  });",
    "  var el = document.getElementById('all-catalogs-list');",
    "  if (!el) return;",
    "  var sortLabels={'popularity.desc':'Popular','vote_average.desc':'Top Rated','release_date.desc':'Newest','revenue.desc':'Revenue'};",
    "  el.innerHTML = state.unifiedOrder.map(function(entry, idx) {",
    "    if (entry.kind==='bestof') {",
    "      var displayName = state.catalogNames['tmdb.bestof'] || '\\u2728 Curated Lists';",
    "      return '<div class=\"catalog-row\" data-uidx=\"'+idx+'\" data-uid=\"bestof:tmdb.bestof\" draggable=\"true\">'",
    "        + '<span class=\"catalog-drag-handle\">&#8801;</span>'",
    "        + '<div class=\"catalog-row-info\">'",
    "          + '<input class=\"catalog-row-name-input\" type=\"text\" value=\"'+esc(displayName)+'\" placeholder=\"\\u2728 Curated Lists\" oninput=\"setCatalogName(\\'tmdb.bestof\\',this.value)\" title=\"Tap to rename\"/>'",
    "          + '<div class=\"catalog-row-type\">Curated Lists &mdash; '+state.customSeasons.length+' list'+(state.customSeasons.length!==1?'s':'')+'</div>'",
    "        + '</div>'",
    "        + '<span style=\"font-size:0.7rem;color:var(--text-mute);padding:0 6px;flex-shrink:0\" title=\"Auto-generated from your curated lists\">auto</span>'",
    "        + '</div>';",
    "    } else if (entry.kind==='default') {",
    "      var c = DEFAULT_CATALOGS.find(function(x){ return x.id===entry.id; });",
    "      if (!c) return '';",
    "      var checked = state.catalogEnabled[c.id]!==undefined ? state.catalogEnabled[c.id] : c.enabled;",
    "      var displayName = state.catalogNames[c.id] || c.name;",
    "      var typeLabel = c.type==='movie'?'TMDB Movie':'TMDB Series';",
    "      return '<div class=\"catalog-row\" data-uidx=\"'+idx+'\" data-uid=\"'+entry.kind+':'+entry.id+'\" draggable=\"true\">'",
    "        + '<span class=\"catalog-drag-handle\">&#8801;</span>'",
    "        + '<div class=\"catalog-row-info\">'",
    "          + '<input class=\"catalog-row-name-input\" type=\"text\" value=\"'+esc(displayName)+'\" placeholder=\"'+esc(c.name)+'\" oninput=\"setCatalogName(\\''+c.id+'\\',this.value)\" title=\"Tap to rename\"/>'",
    "          + '<div class=\"catalog-row-type\">'+typeLabel+'</div>'",
    "        + '</div>'",
    "        + '<label class=\"toggle\"><input type=\"checkbox\" '+(checked?'checked':'')+' onchange=\"setCatalogEnabled(\\''+c.id+'\\',this.checked)\"/><span class=\"toggle-slider\"></span></label>'",
    "        + '</div>';",
    "    } else {",
    "      var c = state.customCatalogs.find(function(x){ return x.id===entry.id; });",
    "      if (!c) return '';",
    "      var sub='';",
    "      if (c.path==='_mdblist_') sub='MDBList &middot; '+c.type;",
    "      else if (c.path==='_imdblist_') sub='IMDB &middot; '+c.type;",
    "      else if (c.path==='_custom_items_') { var _ic=(c.items&&c.items.length||0); var _bc=(c.bestofListIds&&c.bestofListIds.length||0); var _tc=_ic+_bc; sub='Custom Items &middot; '+c.type+' &middot; '+_tc+' item'+(_tc!==1?'s':'')+(_bc>0?' ('+_bc+' list'+(_bc!==1?'s':'')+')':''); }",
    "      else { var sl=(c.params&&sortLabels[c.params.sort_by])||'Popular'; sub='TMDB Discover &middot; '+c.type+' &middot; '+sl; }",
    "      var isItems = c.path==='_custom_items_';",
    "      var isBoost = !!c._boostId;",
    "      var html = '<div class=\"catalog-row catalog-row-custom\" id=\"ccat-'+c.id+'\" data-uidx=\"'+idx+'\" data-uid=\"'+entry.kind+':'+entry.id+'\" draggable=\"true\">'",
    "        + '<span class=\"catalog-drag-handle\">&#8801;</span>'",
    "        + '<div class=\"catalog-row-info\">'",
    "          + '<input class=\"catalog-row-name-input\" type=\"text\" value=\"'+esc(c.name)+'\" oninput=\"updateCustomCatName(\\''+c.id+'\\',this.value)\" onclick=\"event.stopPropagation()\" title=\"Tap to rename\"/>'",
    "          + '<div class=\"catalog-row-type\">'+sub+'</div>'",
    "        + '</div>'",
    "        + '<button class=\"btn btn-ghost btn-sm\" style=\"padding:5px 8px;flex-shrink:0\" onclick=\"event.stopPropagation();toggleCustomCatExpand(\\''+c.id+'\\')\" title=\"Edit\">&#9998;</button>'",
    "        + '<button class=\"btn btn-danger btn-sm\" style=\"flex-shrink:0\" onclick=\"event.stopPropagation();removeCustomCatalog(\\''+c.id+'\\')\">&times;</button>';",
    "      if (isItems) {",
    "        var items = c.items || [];",
    "        var itemsHtml = items.length",
    "          ? '<ul class=\"cat-items-list\">' + items.map(function(item, i) {",
    "              var ph = item.poster ? '<img class=\"cat-item-poster\" src=\"'+item.poster+'\" loading=\"lazy\"/>' : '<div class=\"cat-item-poster\"></div>';",
    "              return '<li class=\"cat-item-row\" data-catid=\"'+c.id+'\" data-itemidx=\"'+i+'\" draggable=\"true\">'",
    "                + '<span class=\"cat-item-drag\">&#8801;</span>'",
    "                + ph",
    "                + '<div class=\"cat-item-info\"><div class=\"cat-item-name\">'+esc(item.name)+'</div><div class=\"cat-item-sub\">'+esc(item.itemType||'')+'</div></div>'",
    "                + '<span class=\"cat-item-del\" onclick=\"removeCatalogItem(\\''+c.id+'\\','+i+')\">&#215;</span>'",
    "                + '</li>';",
    "            }).join('') + '</ul>'",
    "          : '<p style=\"font-size:0.8rem;color:var(--text-mute);margin:4px 0 8px\">No items. Search below to add.</p>';",
    "        // Also show curated lists picker for combined catalogs",
    "        var hasBestofLists = state.customSeasons.length > 0;",
    "        var bestofListIds = c.bestofListIds || [];",
    "        var bestofSection = '';",
    "        if (hasBestofLists) {",
    "          bestofSection += '<div style=\"margin-top:12px;padding-top:10px;border-top:1px solid var(--border)\">'",
    "            + '<div style=\"font-size:0.72rem;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-mute);margin-bottom:8px\">Included Curated Lists</div>'",
    "            + state.customSeasons.map(function(lst) {",
    "                var isIn = bestofListIds.indexOf(lst.listId) !== -1;",
    "                var ph = lst.tmdbPoster ? '<img src=\"'+esc(lst.tmdbPoster)+'\" style=\"width:24px;height:36px;object-fit:cover;border-radius:3px;flex-shrink:0\" loading=\"lazy\"/>' : '<div style=\"width:24px;height:36px;background:var(--surface);border-radius:3px;flex-shrink:0\"></div>';",
    "                return '<div style=\"display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;border:1.5px solid '+(isIn?'var(--gold)':'var(--border)')+';background:'+(isIn?'var(--gold-dim)':'transparent')+';margin-bottom:4px\" onclick=\"toggleBestofListInCat(\\''+c.id+'\\',\\''+lst.listId+'\\')\">'+ph+'<div style=\"flex:1;min-width:0;font-size:0.78rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">'+esc((lst.label||'Best Of')+' \\u2014 '+lst.tmdbName)+'</div><div style=\"font-size:0.72rem;color:'+(isIn?'var(--gold)':'var(--text-mute)')+'\">'+(isIn?'&#10003;':'+ Add')+'</div></div>';",
    "              }).join('')",
    "            + '</div>';",
    "        }",
    "        html += '<div class=\"custom-catalog-editor\">'",
    "          + '<div style=\"font-size:0.72rem;color:var(--text-dim);margin-bottom:8px;font-weight:600\">Items &mdash; drag to reorder, &times; to remove</div>'",
    "          + itemsHtml",
    "          + '<div style=\"margin-top:10px\">'",
    "            + '<input type=\"text\" id=\"catitems-search-'+c.id+'\" placeholder=\"Search to add '+c.type+'s...\" oninput=\"debounceCatItemSearch(\\''+c.id+'\\',\\''+c.type+'\\',this.value)\" autocomplete=\"off\" style=\"font-size:0.82rem\"/>'",
    "            + '<div id=\"catitems-results-'+c.id+'\" style=\"margin-top:4px;max-height:200px;overflow-y:auto\"></div>'",
    "          + '</div>'",
    "          + bestofSection",
    "          + '</div>';",
    "      } else {",
    "        // Edit panel for TMDB-discover, MDBList, IMDB, bestof catalogs",
    "        var editFields = '';",
    "        editFields += '<div style=\"font-size:0.72rem;color:var(--text-dim);font-weight:600;margin-bottom:8px\">Edit Catalog</div>';",
    "        editFields += '<div style=\"margin-bottom:8px\"><label style=\"font-size:0.65rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.07em\">Catalog Name</label><input type=\"text\" value=\"'+esc(c.name)+'\" oninput=\"updateCustomCatName(\\''+c.id+'\\',this.value)\" style=\"font-size:0.82rem\" onclick=\"event.stopPropagation()\"/></div>';",
    "        if (c.path === '_mdblist_') {",
    "          editFields += '<div style=\"margin-bottom:8px\"><label style=\"font-size:0.65rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.07em\">MDBList URL</label><input type=\"text\" value=\"'+esc(c.mdblistUrl||'')+'\" oninput=\"updateCatField(\\''+c.id+'\\',\\'mdblistUrl\\',this.value)\" placeholder=\"https://mdblist.com/lists/...\" style=\"font-size:0.82rem\" onclick=\"event.stopPropagation()\"/></div>';",
    "        } else if (c.path === '_imdblist_') {",
    "          editFields += '<div style=\"margin-bottom:8px\"><label style=\"font-size:0.65rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.07em\">IMDB List URL</label><input type=\"text\" value=\"'+esc(c.imdbUrl||'')+'\" oninput=\"updateCatField(\\''+c.id+'\\',\\'imdbUrl\\',this.value)\" placeholder=\"https://www.imdb.com/list/ls.../\" style=\"font-size:0.82rem\" onclick=\"event.stopPropagation()\"/></div>';",
    "        } else if (c.path && c.path.startsWith('/discover/')) {",
    "          var sortVal = (c.params && c.params.sort_by) || 'popularity.desc';",
    "          var genreVal = (c.params && c.params.with_genres) || '';",
    "          var langVal = (c.params && c.params.with_original_language) || '';",
    "          var minVotesVal = (c.params && c.params['vote_count.gte']) || '';",
    "          var minRatingVal = (c.params && c.params['vote_average.gte']) || '';",
    "          var networkVal = (c.params && c.params.with_networks) || '';",
    "          editFields += '<div class=\"form-row\" style=\"margin-bottom:8px\">';",
    "          editFields += '<div class=\"field\" style=\"margin-bottom:0;flex:1\"><label style=\"font-size:0.65rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.07em\">Sort By</label><select onchange=\"updateCatParam(\\''+c.id+'\\',\\'sort_by\\',this.value)\" onclick=\"event.stopPropagation()\" style=\"font-size:0.82rem\">'",
    "            + ['popularity.desc','vote_average.desc','release_date.desc','revenue.desc'].map(function(s){return '<option value=\"'+s+'\"'+(sortVal===s?' selected':'')+'>'+({'popularity.desc':'Popular','vote_average.desc':'Top Rated','release_date.desc':'Newest','revenue.desc':'Revenue'}[s]||s)+'</option>';}).join('')",
    "            + '</select></div>';",
    "          editFields += '<div class=\"field\" style=\"margin-bottom:0;flex:1\"><label style=\"font-size:0.65rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.07em\">Genre</label><select onchange=\"updateCatParam(\\''+c.id+'\\',\\'with_genres\\',this.value)\" onclick=\"event.stopPropagation()\" style=\"font-size:0.82rem\" class=\"edit-genre-select\" data-catid=\"'+c.id+'\" data-val=\"'+esc(genreVal)+'\"><option value=\"\">Any</option></select></div>';",
    "          editFields += '<div class=\"field\" style=\"margin-bottom:0;flex:1\"><label style=\"font-size:0.65rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.07em\">Language</label><select onchange=\"updateCatParam(\\''+c.id+'\\',\\'with_original_language\\',this.value)\" onclick=\"event.stopPropagation()\" style=\"font-size:0.82rem\">'",
    "            + [['','Any'],['en','English'],['ko','Korean'],['ja','Japanese'],['fr','French'],['es','Spanish'],['de','German'],['it','Italian'],['pt','Portuguese'],['zh','Chinese'],['hi','Hindi'],['ar','Arabic'],['ru','Russian'],['tr','Turkish'],['th','Thai']].map(function(l){return '<option value=\"'+l[0]+'\"'+(langVal===l[0]?' selected':'')+'>'+l[1]+'</option>';}).join('')",
    "            + '</select></div>';",
    "          editFields += '</div>';",
    "          editFields += '<div class=\"form-row\" style=\"margin-bottom:8px\">';",
    "          editFields += '<div class=\"field\" style=\"margin-bottom:0;flex:1\"><label style=\"font-size:0.65rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.07em\">Min Votes</label><input type=\"number\" value=\"'+esc(minVotesVal)+'\" placeholder=\"e.g. 100\" oninput=\"updateCatParam(\\''+c.id+'\\',\\'vote_count.gte\\',this.value)\" onclick=\"event.stopPropagation()\" style=\"font-size:0.82rem\"/></div>';",
    "          editFields += '<div class=\"field\" style=\"margin-bottom:0;flex:1\"><label style=\"font-size:0.65rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.07em\">Min Rating</label><input type=\"number\" value=\"'+esc(minRatingVal)+'\" placeholder=\"e.g. 7.5\" step=\"0.1\" min=\"0\" max=\"10\" oninput=\"updateCatParam(\\''+c.id+'\\',\\'vote_average.gte\\',this.value)\" onclick=\"event.stopPropagation()\" style=\"font-size:0.82rem\"/></div>';",
    "          if (c.type==='series') {",
    "            editFields += '<div class=\"field\" style=\"margin-bottom:0;flex:1\"><label style=\"font-size:0.65rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.07em\">Network</label><select onchange=\"updateCatParam(\\''+c.id+'\\',\\'with_networks\\',this.value)\" onclick=\"event.stopPropagation()\" style=\"font-size:0.82rem\">'",
    "              + [['','Any'],['213','Netflix'],['1024','Amazon Prime'],['2739','Disney+'],['49','HBO'],['2552','Apple TV+'],['453','Hulu'],['67','Showtime'],['56','AMC'],['19','FX'],['77','Starz'],['318','Peacock'],['3353','Paramount+'],['4330','Max']].map(function(n){return '<option value=\"'+n[0]+'\"'+(networkVal===n[0]?' selected':'')+'>'+n[1]+'</option>';}).join('')",
    "              + '</select></div>';",
    "          }",
    "          editFields += '</div>';",
    "        } else if (c.path === '_bestof_') {",
    "          var listCount = (c.bestofListIds||[]).length;",
    "          editFields += '<div style=\"font-size:0.72rem;color:var(--text-mute);margin-bottom:8px\">Contains '+listCount+' curated list'+(listCount!==1?'s':'')+'. Select lists below to update:</div>';",
    "          editFields += '<div style=\"max-height:200px;overflow-y:auto;margin-bottom:8px\">';",
    "          var allLists=state.customSeasons;",
    "          if(allLists.length){",
    "            editFields+=allLists.map(function(lst){",
    "              var isIn=(c.bestofListIds||[]).indexOf(lst.listId)!==-1;",
    "              var ph=lst.tmdbPoster?'<img src=\"'+esc(lst.tmdbPoster)+'\" style=\"width:24px;height:36px;object-fit:cover;border-radius:3px;flex-shrink:0\" loading=\"lazy\"/>':'<div style=\"width:24px;height:36px;background:var(--surface);border-radius:3px;flex-shrink:0\"></div>';",
    "              return '<div style=\"display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;border:1.5px solid '+(isIn?'var(--gold)':'var(--border)')+';background:'+(isIn?'var(--gold-dim)':'transparent')+';margin-bottom:4px\" onclick=\"toggleBestofListInCat(\\''+c.id+'\\',\\''+lst.listId+'\\')\">'+ph+'<div style=\"flex:1;min-width:0;font-size:0.78rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">'+esc((lst.label||'Best Of')+' \u2014 '+lst.tmdbName)+'</div><div style=\"font-size:0.72rem;color:'+(isIn?'var(--gold)':'var(--text-mute)')+'\">'+(isIn?'&#10003;':'+ Add')+'</div></div>';",
    "            }).join('');",
    "          } else {",
    "            editFields+='<div style=\"font-size:0.75rem;color:var(--text-mute);padding:6px\">No curated lists created yet.</div>';",
    "          }",
    "          editFields+='</div>';",
    "        }",
    "        editFields += '<div style=\"margin-top:8px;display:flex;gap:6px\"><select onclick=\"event.stopPropagation()\" onchange=\"updateCatField(\\''+c.id+'\\',\\'type\\',this.value)\" style=\"font-size:0.8rem;padding:6px 10px;width:auto\"><option value=\"movie\"'+(c.type==='movie'?' selected':'')+'>Movie</option><option value=\"series\"'+(c.type==='series'?' selected':'')+'>Series</option></select></div>';",
    "        html += '<div class=\"custom-catalog-editor\">'+editFields+'</div>';",
    "      }",
    "      html += '</div>';",
    "      return html;",
    "    }",
    "  }).join('');",
    "  initUnifiedDragSort();",
    "  initCatalogItemsDragSort();",
    "}",
    "function setCatalogEnabled(id, val) { state.catalogEnabled[id]=val; }",
    "function setCatalogName(id, val) { state.catalogNames[id]=val; }",
    "function updateCustomCatName(id, val) { var c=state.customCatalogs.find(function(x){return x.id===id;}); if(c) c.name=val; }",
    "function updateCatField(id, field, val) { var c=state.customCatalogs.find(function(x){return x.id===id;}); if(c) c[field]=val; }",
    "function updateCatParam(id, param, val) { var c=state.customCatalogs.find(function(x){return x.id===id;}); if(c){ if(!c.params) c.params={}; c.params[param]=val; } }",
    "function removeCustomCatalog(id) {",
    "  state.customCatalogs = state.customCatalogs.filter(function(c){ return c.id!==id; });",
    "  state.unifiedOrder = state.unifiedOrder.filter(function(o){ return !(o.kind==='custom'&&o.id===id); });",
    "  renderUnifiedCatalogList();",
    "}",
    "function toggleCustomCatExpand(id) {",
    "  var el=document.getElementById('ccat-'+id); if(el) el.classList.toggle('expanded');",
    "  // Load genres for discover edit selects when expanding",
    "  if(el&&el.classList.contains('expanded')) {",
    "    el.querySelectorAll('.edit-genre-select').forEach(function(sel){",
    "      if(sel.options.length>1) return;",
    "      var catId=sel.dataset.catid; var curVal=sel.dataset.val||'';",
    "      var c=state.customCatalogs.find(function(x){return x.id===catId;});",
    "      var tt=(c&&c.type==='series')?'tv':'movie';",
    "      fetch('/api/genres?apiKey='+encodeURIComponent(state.apiKey)+'&type='+tt).then(function(r){return r.json();}).then(function(d){",
    "        if(!d.genres) return;",
    "        d.genres.forEach(function(g){ var opt=document.createElement('option'); opt.value=String(g.id); opt.textContent=g.name; if(String(g.id)===curVal) opt.selected=true; sel.appendChild(opt); });",
    "      }).catch(function(){});",
    "    });",
    "  }",
    "}",
    "function toggleBestofListInCat(catId, listId) {",
    "  var c=state.customCatalogs.find(function(x){return x.id===catId;}); if(!c) return;",
    "  if(!c.bestofListIds) c.bestofListIds=[];",
    "  var idx=c.bestofListIds.indexOf(listId);",
    "  if(idx!==-1) c.bestofListIds.splice(idx,1);",
    "  else c.bestofListIds.push(listId);",
    "  var wasExp=document.getElementById('ccat-'+catId)&&document.getElementById('ccat-'+catId).classList.contains('expanded');",
    "  renderUnifiedCatalogList();",
    "  if(wasExp){setTimeout(function(){var el=document.getElementById('ccat-'+catId);if(el)el.classList.add('expanded');},20);}",
    "}",
    "function removeCatalogItem(catId, idx) {",
    "  var c=state.customCatalogs.find(function(x){return x.id===catId;});",
    "  if (!c||!c.items) return;",
    "  var wasExp = document.getElementById('ccat-'+catId) && document.getElementById('ccat-'+catId).classList.contains('expanded');",
    "  c.items.splice(idx,1);",
    "  renderUnifiedCatalogList();",
    "  if (wasExp) { var el=document.getElementById('ccat-'+catId); if(el) el.classList.add('expanded'); }",
    "}",
    "",
    "function initUnifiedDragSort() {",
    "  var listEl = document.getElementById('all-catalogs-list');",
    "  if (!listEl) return;",
    "  var items = listEl.querySelectorAll('.catalog-row[data-uidx]');",
    "  var dragIdx = null;",
    "  items.forEach(function(item) {",
    "    item.addEventListener('dragstart', function(e) {",
    "      if (e.target.closest('.custom-catalog-editor')) { e.preventDefault(); return; }",
    "      dragIdx = parseInt(item.dataset.uidx);",
    "      item.classList.add('dragging-def');",
    "      e.dataTransfer.effectAllowed = 'move';",
    "    });",
    "    item.addEventListener('dragend', function() {",
    "      item.classList.remove('dragging-def');",
    "      listEl.querySelectorAll('.catalog-row').forEach(function(i){ i.classList.remove('drag-over-def'); });",
    "    });",
    "    item.addEventListener('dragover', function(e) {",
    "      if (e.target.closest('.custom-catalog-editor')) return;",
    "      e.preventDefault();",
    "      listEl.querySelectorAll('.catalog-row').forEach(function(i){ i.classList.remove('drag-over-def'); });",
    "      item.classList.add('drag-over-def');",
    "    });",
    "    item.addEventListener('drop', function(e) {",
    "      if (e.target.closest('.custom-catalog-editor')) return;",
    "      e.preventDefault();",
    "      item.classList.remove('drag-over-def');",
    "      var toIdx = parseInt(item.dataset.uidx);",
    "      if (dragIdx !== null && dragIdx !== toIdx) {",
    "        initUnifiedOrder();",
    "        var moved = state.unifiedOrder.splice(dragIdx, 1)[0];",
    "        state.unifiedOrder.splice(toIdx, 0, moved);",
    "        renderUnifiedCatalogList();",
    "      }",
    "      dragIdx = null;",
    "    });",
    "  });",
    "  items.forEach(function(item) {",
    "    var handle = item.querySelector('.catalog-drag-handle');",
    "    if (!handle) return;",
    "    var clone = null, startY = 0;",
    "    handle.addEventListener('touchstart', function(e) {",
    "      if (e.target.closest('.custom-catalog-editor')) return;",
    "      dragIdx = parseInt(item.dataset.uidx);",
    "      var touch = e.touches[0];",
    "      startY = touch.clientY;",
    "      var rect = item.getBoundingClientRect();",
    "      clone = item.cloneNode(true);",
    "      clone.style.cssText = 'position:fixed;left:'+rect.left+'px;top:'+rect.top+'px;width:'+rect.width+'px;opacity:0.9;z-index:9999;pointer-events:none;border:1px solid var(--gold);border-radius:10px;background:var(--surface);';",
    "      document.body.appendChild(clone);",
    "      item.style.opacity = '0.3';",
    "      e.preventDefault();",
    "    }, { passive: false });",
    "    handle.addEventListener('touchmove', function(e) {",
    "      if (!clone || dragIdx === null) return;",
    "      var touch = e.touches[0];",
    "      var dy = touch.clientY - startY;",
    "      var rect = item.getBoundingClientRect();",
    "      clone.style.top = (rect.top + dy) + 'px';",
    "      listEl.querySelectorAll('.catalog-row').forEach(function(i){ i.classList.remove('drag-over-def'); });",
    "      var el = document.elementFromPoint(touch.clientX, touch.clientY);",
    "      var target = el ? el.closest('.catalog-row[data-uidx]') : null;",
    "      if (target) target.classList.add('drag-over-def');",
    "      e.preventDefault();",
    "    }, { passive: false });",
    "    handle.addEventListener('touchend', function(e) {",
    "      if (clone) { document.body.removeChild(clone); clone = null; }",
    "      item.style.opacity = '';",
    "      listEl.querySelectorAll('.catalog-row').forEach(function(i){ i.classList.remove('drag-over-def'); });",
    "      if (dragIdx === null) return;",
    "      var touch = e.changedTouches[0];",
    "      var el = document.elementFromPoint(touch.clientX, touch.clientY);",
    "      var target = el ? el.closest('.catalog-row[data-uidx]') : null;",
    "      if (target) {",
    "        var toIdx = parseInt(target.dataset.uidx);",
    "        if (toIdx !== dragIdx) {",
    "          initUnifiedOrder();",
    "          var moved = state.unifiedOrder.splice(dragIdx, 1)[0];",
    "          state.unifiedOrder.splice(toIdx, 0, moved);",
    "          renderUnifiedCatalogList();",
    "        }",
    "      }",
    "      dragIdx = null;",
    "    });",
    "  });",
    "}",
    "",
    "function initCatalogItemsDragSort() {",
    "  document.querySelectorAll('.cat-items-list').forEach(function(listEl) {",
    "    var items = listEl.querySelectorAll('.cat-item-row');",
    "    var dragItemIdx = null; var dragCatId = null;",
    "    items.forEach(function(item) {",
    "      item.addEventListener('dragstart', function(e) {",
    "        dragItemIdx=parseInt(item.dataset.itemidx); dragCatId=item.dataset.catid;",
    "        item.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; e.stopPropagation();",
    "      });",
    "      item.addEventListener('dragend', function() { item.classList.remove('dragging'); items.forEach(function(i){i.classList.remove('drag-over-item');}); });",
    "      item.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); items.forEach(function(i){i.classList.remove('drag-over-item');}); item.classList.add('drag-over-item'); });",
    "      item.addEventListener('drop', function(e) {",
    "        e.preventDefault(); e.stopPropagation(); item.classList.remove('drag-over-item');",
    "        var toIdx=parseInt(item.dataset.itemidx);",
    "        if (dragItemIdx===null||dragItemIdx===toIdx||!dragCatId) return;",
    "        var c=state.customCatalogs.find(function(x){return x.id===dragCatId;});",
    "        if (!c||!c.items) return;",
    "        var moved=c.items.splice(dragItemIdx,1)[0]; c.items.splice(toIdx,0,moved);",
    "        renderUnifiedCatalogList();",
    "        setTimeout(function(){ var el=document.getElementById('ccat-'+dragCatId); if(el) el.classList.add('expanded'); },20);",
    "        dragItemIdx=null;",
    "      });",
    "    });",
    "  });",
    "}",
    "",
    "function switchAddCatTab(tab) {",
    "  ['items','tmdb-builder','mdblist','imdb'].forEach(function(t) {",
    "    var btn=document.getElementById('add-cat-tab-'+t);",
    "    var panel=document.getElementById('add-cat-panel-'+t);",
    "    if (btn) btn.classList.toggle('active', t===tab);",
    "    if (panel) panel.classList.toggle('active', t===tab);",
    "  });",
    "  if (tab==='tmdb-builder') loadGenresForCustom();",
    "  if (tab==='items') renderBestOfItemsPicker();",
    "}",
    "",
    "function toggleCustomCatalogForm() {",
    "  var form=document.getElementById('custom-catalog-form');",
    "  form.classList.toggle('open');",
    "  if (form.classList.contains('open')) {",
    "    document.getElementById('cc-step-name').classList.add('active');",
    "    document.getElementById('cc-step-source').classList.remove('active');",
    "    document.getElementById('cc-new-name').value='';",
    "    document.getElementById('cc-new-type').value='movie';",
    "    newCatalogItems=[];",
    "  }",
    "}",
    "function ccGoStep2() {",
    "  var name=document.getElementById('cc-new-name').value.trim();",
    "  if (!name) { var n=document.getElementById('cc-new-name'); n.classList.add('error'); setTimeout(function(){ n.classList.remove('error'); },1500); return; }",
    "  document.getElementById('cc-step2-name-display').textContent=name+' ('+document.getElementById('cc-new-type').value+')';",
    "  document.getElementById('cc-step-name').classList.remove('active');",
    "  document.getElementById('cc-step-source').classList.add('active');",
    "  switchAddCatTab('items');",
    "  newCatalogItems=[]; renderNewCatalogItems();",
    "}",
    "function ccBackStep1() {",
    "  document.getElementById('cc-step-source').classList.remove('active');",
    "  document.getElementById('cc-step-name').classList.add('active');",
    "}",
    "",
    "async function loadGenresForCustom() {",
    "  var type=document.getElementById('cc-new-type').value;",
    "  var tt=type==='series'?'tv':'movie';",
    "  if (genreCache[tt]) { populateGenreSelect(genreCache[tt]); return; }",
    "  try {",
    "    var r=await fetch('/api/genres?apiKey='+encodeURIComponent(state.apiKey)+'&type='+tt);",
    "    var d=await r.json();",
    "    genreCache[tt]=d.genres||[]; populateGenreSelect(genreCache[tt]);",
    "  } catch(e) {}",
    "}",
    "function populateGenreSelect(genres) {",
    "  var sel=document.getElementById('cc-genre');",
    "  if (!sel) return;",
    "  sel.innerHTML='<option value=\"\">Any Genre</option>'+genres.map(function(g){ return '<option value=\"'+g.id+'\">'+esc(g.name)+'</option>'; }).join('');",
    "}",
    "",
    "var newCatalogItems = [];",
    "var itemsSearchTimer;",
    "function debounceItemsSearch(q) {",
    "  clearTimeout(itemsSearchTimer);",
    "  var box=document.getElementById('cc-items-results');",
    "  if (!q.trim()) { if(box) box.innerHTML=''; return; }",
    "  itemsSearchTimer=setTimeout(function(){ doItemsSearch(q); },350);",
    "}",
    "async function doItemsSearch(q) {",
    "  var type=document.getElementById('cc-new-type').value;",
    "  var box=document.getElementById('cc-items-results');",
    "  if (!box) return;",
    "  box.innerHTML='<div class=\"loading-state\" style=\"padding:0.5rem 0\"><div class=\"spinner-light\"></div> Searching...</div>';",
    "  try {",
    "    var r=await fetch('/api/search-multi?q='+encodeURIComponent(q)+'&apiKey='+encodeURIComponent(state.apiKey)+'&type='+type);",
    "    var d=await r.json();",
    "    if (!d.results||!d.results.length) { box.innerHTML='<p style=\"font-size:0.78rem;color:var(--text-mute);padding:4px\">No results.</p>'; return; }",
    "    box.innerHTML=d.results.map(function(s) {",
    "      var already=newCatalogItems.find(function(i){ return i.tmdbId===String(s.id); });",
    "      var ph=s.poster?'<img class=\"cat-search-result-poster\" src=\"'+s.poster+'\" loading=\"lazy\"/>':'<div class=\"cat-search-result-poster\"></div>';",
    "      return '<div class=\"cat-search-result'+(already?' cat-search-added':'')+'\" onclick=\"addItemToCatalog('+s.id+',\\''+esc4attr(s.name)+'\\',\\''+esc4attr(s.poster||'')+'\\',\\''+type+'\\')\">'",
    "        +ph+'<div style=\"flex:1;min-width:0\"><div style=\"font-size:0.82rem;font-weight:600;color:var(--text)\">'+esc(s.name)+'</div><div style=\"font-size:0.7rem;color:var(--text-mute)\">'+(s.year||'')+'</div></div>'",
    "        +'<div style=\"font-size:0.75rem;color:'+(already?'var(--gold)':'var(--text-mute)')+'\">'+(already?'&#10003; Added':'+ Add')+'</div></div>';",
    "    }).join('');",
    "  } catch(e) { if(box) box.innerHTML=''; }",
    "}",
    "function addItemToCatalog(tmdbId, name, poster, itemType) {",
    "  var already=newCatalogItems.find(function(i){ return i.tmdbId===String(tmdbId); });",
    "  if (already) return;",
    "  newCatalogItems.push({tmdbId:String(tmdbId),name:name,poster:poster,itemType:itemType});",
    "  renderNewCatalogItems();",
    "  var inp=document.getElementById('cc-items-search');",
    "  if (inp&&inp.value) doItemsSearch(inp.value);",
    "}",
    "function removeNewCatalogItem(idx) { newCatalogItems.splice(idx,1); renderNewCatalogItems(); }",
    "function renderNewCatalogItems() {",
    "  var el=document.getElementById('cc-items-picked'); if(!el) return;",
    "  if (!newCatalogItems.length) { el.innerHTML='<p style=\"font-size:0.75rem;color:var(--text-mute)\">No items added yet.</p>'; return; }",
    "  el.innerHTML='<div style=\"font-size:0.72rem;color:var(--text-mute);margin-bottom:6px\">'+newCatalogItems.length+' item'+(newCatalogItems.length!==1?'s':'')+' &mdash; tap to remove</div>'",
    "    +'<div style=\"display:flex;flex-wrap:wrap;gap:6px\">'",
    "    +newCatalogItems.map(function(item,i){",
    "      var ph=item.poster?'<img style=\"width:36px;height:54px;border-radius:4px;object-fit:cover\" src=\"'+item.poster+'\" loading=\"lazy\"/>':'<div style=\"width:36px;height:54px;background:var(--surface2);border-radius:4px\"></div>';",
    "      return '<div style=\"position:relative;cursor:pointer\" title=\"'+esc(item.name)+'\" onclick=\"removeNewCatalogItem('+i+')\">'+ph+'<div style=\"position:absolute;top:-3px;right:-3px;width:14px;height:14px;background:#c0392b;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff\">&times;</div></div>';",
    "    }).join('')+'</div>';",
    "}",
    "function addItemsCatalog() {",
    "  var name=document.getElementById('cc-new-name').value.trim();",
    "  var type=document.getElementById('cc-new-type').value;",
    "  var bestofIds=window._bestofPickSelection?Array.from(window._bestofPickSelection):[];",
    "  var hasItems=newCatalogItems.length>0;",
    "  var hasBestof=bestofIds.length>0;",
    "  if (!name) return;",
    "  if (!hasItems && !hasBestof) return;",
    "  // FIX: strip trailing movie/series/show suffix from custom catalog name",
    "  var cleanName = name.replace(/\\s+(movies?|series|shows?)$/i, '').trim() || name;",
    "  var newCat;",
    "  if (hasItems && hasBestof) {",
    "    // Combined catalog with both picked items and bestof lists",
    "    newCat={id:'custom_items.'+Date.now(),name:cleanName,type:type,path:'_custom_items_',items:newCatalogItems.slice(),bestofListIds:bestofIds,enabled:true};",
    "  } else if (hasBestof) {",
    "    newCat={id:'bestofcat.'+Date.now(),name:cleanName,type:'series',path:'_bestof_',bestofListIds:bestofIds,enabled:true};",
    "  } else {",
    "    newCat={id:'custom_items.'+Date.now(),name:cleanName,type:type,path:'_custom_items_',items:newCatalogItems.slice(),enabled:true};",
    "  }",
    "  state.customCatalogs.push(newCat);",
    "  initUnifiedOrder(); state.unifiedOrder.push({kind:'custom',id:newCat.id});",
    "  newCatalogItems=[];",
    "  window._bestofPickSelection=new Set();",
    "  // Close form and reset steps",
    "  var form=document.getElementById('custom-catalog-form');",
    "  form.classList.remove('open');",
    "  document.getElementById('cc-step-name').classList.add('active');",
    "  document.getElementById('cc-step-source').classList.remove('active');",
    "  document.getElementById('cc-new-name').value='';",
    "  renderUnifiedCatalogList();",
    "  showToast('Catalog \\u201c'+cleanName+'\\u201d created');",
    "}",
    "function toggleAdvancedCatOptions(btn) {",
    "  var adv=document.getElementById('cc-advanced');",
    "  if(!adv) return;",
    "  var open=adv.style.display!=='none';",
    "  adv.style.display=open?'none':'block';",
    "  btn.textContent=open?'\u2699\uFE0F Advanced options':'\u2699\uFE0F Hide advanced';",
    "}",
    "",
    "function addCustomCatalog() {",
    "  var name=document.getElementById('cc-new-name').value.trim();",
    "  var type=document.getElementById('cc-new-type').value;",
    "  var genre=document.getElementById('cc-genre').value;",
    "  var sort=document.getElementById('cc-sort').value;",
    "  var lang=document.getElementById('cc-language')?document.getElementById('cc-language').value.trim():'';",
    "  // Advanced options",
    "  var minVotes=document.getElementById('cc-min-votes')?document.getElementById('cc-min-votes').value.trim():'';",
    "  var minYear=document.getElementById('cc-min-year')?document.getElementById('cc-min-year').value.trim():'';",
    "  var maxYear=document.getElementById('cc-max-year')?document.getElementById('cc-max-year').value.trim():'';",
    "  var minRating=document.getElementById('cc-min-rating')?document.getElementById('cc-min-rating').value.trim():'';",
    "  var keyword=document.getElementById('cc-keyword')?document.getElementById('cc-keyword').value.trim():'';",
    "  var network=document.getElementById('cc-network')?document.getElementById('cc-network').value.trim():'';",
    "  var adult=document.getElementById('cc-adult')?document.getElementById('cc-adult').checked:false;",
    "  if (!name) return;",
    "  var cleanName = name.replace(/\\s+(movies?|series|shows?)$/i, '').trim() || name;",
    "  var tt=type==='series'?'tv':'movie';",
    "  var params={sort_by:sort};",
    "  if(genre) params.with_genres=genre;",
    "  if(minVotes) params['vote_count.gte']=minVotes;",
    "  if(minRating) params['vote_average.gte']=minRating;",
    "  if(lang) params.with_original_language=lang;",
    "  if(keyword) params.with_keywords=keyword;",
    "  if(adult) params.include_adult='true';",
    "  if(type==='movie'){",
    "    if(minYear) params['primary_release_date.gte']=minYear+'-01-01';",
    "    if(maxYear) params['primary_release_date.lte']=maxYear+'-12-31';",
    "  } else {",
    "    if(minYear) params['first_air_date.gte']=minYear+'-01-01';",
    "    if(maxYear) params['first_air_date.lte']=maxYear+'-12-31';",
    "    if(network) params.with_networks=network;",
    "  }",
    "  var newCat={id:'custom.'+Date.now(),name:cleanName,type:type,path:'/discover/'+tt,params:params,enabled:true};",
    "  state.customCatalogs.push(newCat);",
    "  initUnifiedOrder(); state.unifiedOrder.push({kind:'custom',id:newCat.id});",
    "  // Close form and reset",
    "  var form=document.getElementById('custom-catalog-form');",
    "  form.classList.remove('open');",
    "  document.getElementById('cc-step-name').classList.add('active');",
    "  document.getElementById('cc-step-source').classList.remove('active');",
    "  document.getElementById('cc-new-name').value='';",
    "  renderUnifiedCatalogList();",
    "  showToast('Catalog \\u201c'+cleanName+'\\u201d added');",
    "}",
    "",
    "function renderBestOfCatalogPicker() { renderBestOfItemsPicker(); }",
    "function renderBestOfItemsPicker() {",
    "  var container=document.getElementById('cc-bestof-inline');",
    "  if(!container) return;",
    "  var pickList=container.querySelector('.bestof-pick-list');",
    "  if(!pickList) return;",
    "  var lists=state.customSeasons;",
    "  if(!lists.length){pickList.innerHTML='<div style=\"font-size:0.78rem;color:var(--text-mute);padding:4px 0\">No curated lists yet. Create some in the Lists step.</div>';return;}",
    "  if (!window._bestofPickSelection) window._bestofPickSelection = new Set();",
    "  pickList.innerHTML=lists.map(function(list){",
    "    var selected=window._bestofPickSelection.has(list.listId);",
    "    var ph=list.posterUrl||list.tmdbPoster;",
    "    var img=ph?'<img src=\"'+ph+'\" style=\"width:28px;height:42px;object-fit:cover;border-radius:4px;flex-shrink:0\" loading=\"lazy\"/>':'<div style=\"width:28px;height:42px;background:var(--surface);border-radius:4px;flex-shrink:0\"></div>';",
    "    var name=esc((list.label||'Best Of')+' \\u2014 '+list.tmdbName);",
    "    return '<div class=\"cat-search-result'+(selected?' cat-search-added':'')+'\" style=\"cursor:pointer\" onclick=\"toggleBestOfPick(\\'' + list.listId + '\\')\">'",
    "      +img+'<div style=\"flex:1;min-width:0\"><div style=\"font-size:0.82rem;font-weight:600;color:var(--text)\">'+name+'</div><div style=\"font-size:0.7rem;color:var(--text-mute)\">'+list.episodes.length+' ep'+(list.episodes.length!==1?'s':'')+'</div></div>'",
    "      +'<div style=\"font-size:0.75rem;color:'+(selected?'var(--gold)':'var(--text-mute)')+'\">'+(selected?'&#10003; Selected':'+ Select')+'</div></div>';",
    "  }).join('');",
    "}",
    "function toggleBestOfPick(listId) {",
    "  if (!window._bestofPickSelection) window._bestofPickSelection = new Set();",
    "  if (window._bestofPickSelection.has(listId)) window._bestofPickSelection.delete(listId);",
    "  else window._bestofPickSelection.add(listId);",
    "  renderBestOfItemsPicker();",
    "}",
    "",
    "var catItemSearchTimers={};",
    "function debounceCatItemSearch(catId,itemType,q) {",
    "  clearTimeout(catItemSearchTimers[catId]);",
    "  var box=document.getElementById('catitems-results-'+catId);",
    "  if (!q.trim()) { if(box) box.innerHTML=''; return; }",
    "  catItemSearchTimers[catId]=setTimeout(function(){ doCatItemSearch(catId,itemType,q); },350);",
    "}",
    "async function doCatItemSearch(catId,itemType,q) {",
    "  var box=document.getElementById('catitems-results-'+catId); if(!box) return;",
    "  box.innerHTML='<div class=\"loading-state\" style=\"padding:0.4rem 0\"><div class=\"spinner-light\"></div></div>';",
    "  try {",
    "    var r=await fetch('/api/search-multi?q='+encodeURIComponent(q)+'&apiKey='+encodeURIComponent(state.apiKey)+'&type='+itemType);",
    "    var d=await r.json();",
    "    if (!d.results||!d.results.length) { box.innerHTML='<p style=\"font-size:0.75rem;color:var(--text-mute)\">No results.</p>'; return; }",
    "    var c=state.customCatalogs.find(function(x){ return x.id===catId; });",
    "    box.innerHTML=d.results.slice(0,6).map(function(s) {",
    "      var already=c&&c.items&&c.items.find(function(i){ return i.tmdbId===String(s.id); });",
    "      var ph=s.poster?'<img class=\"cat-search-result-poster\" src=\"'+s.poster+'\" loading=\"lazy\"/>':'<div class=\"cat-search-result-poster\"></div>';",
    "      return '<div class=\"cat-search-result'+(already?' cat-search-added':'')+'\" onclick=\"addItemToExistingCatalog(\\''+catId+'\\','+s.id+',\\''+esc4attr(s.name)+'\\',\\''+esc4attr(s.poster||'')+'\\',\\''+itemType+'\\')\">'",
    "        +ph+'<div style=\"flex:1;min-width:0\"><div style=\"font-size:0.79rem;font-weight:600;color:var(--text)\">'+esc(s.name)+'</div><div style=\"font-size:0.68rem;color:var(--text-mute)\">'+(s.year||'')+'</div></div>'",
    "        +'<div style=\"font-size:0.73rem;color:'+(already?'var(--gold)':'var(--text-mute)')+'\">'+(already?'&#10003;':'+ Add')+'</div></div>';",
    "    }).join('');",
    "  } catch(e) { if(box) box.innerHTML=''; }",
    "}",
    "function addItemToExistingCatalog(catId,tmdbId,name,poster,itemType) {",
    "  var c=state.customCatalogs.find(function(x){return x.id===catId;}); if(!c) return;",
    "  if (!c.items) c.items=[];",
    "  if (c.items.find(function(i){return i.tmdbId===String(tmdbId);})) return;",
    "  c.items.push({tmdbId:String(tmdbId),name:name,poster:poster,itemType:itemType});",
    "  var inp=document.getElementById('catitems-search-'+catId);",
    "  var q=inp?inp.value:'';",
    "  renderUnifiedCatalogList();",
    "  setTimeout(function(){",
    "    var el=document.getElementById('ccat-'+catId); if(el) el.classList.add('expanded');",
    "    if (q) { var newInp=document.getElementById('catitems-search-'+catId); if(newInp){newInp.value=q; doCatItemSearch(catId,itemType,q);} }",
    "  },20);",
    "}",
    "",
    "var mdbCatalogPreviewData = null;",
    "async function previewMdbCatalog() {",
    "  var input = document.getElementById('mdb-cat-url');",
    "  var status = document.getElementById('mdb-cat-status');",
    "  var btn = document.getElementById('mdb-cat-btn');",
    "  var preview = document.getElementById('mdb-cat-preview');",
    "  var url = (input ? input.value : '').trim();",
    "  if (!url) { status.textContent = 'Please enter an MDBList URL'; status.style.color = '#e05252'; return; }",
    "  btn.disabled = true; btn.innerHTML = '<span class=\"spinner-light\"></span>';",
    "  status.textContent = 'Fetching list\u2026'; status.style.color = 'var(--text-mute)';",
    "  preview.style.display = 'none'; mdbCatalogPreviewData = null;",
    "  try {",
    "    var r = await fetch('/api/mdblist-catalog?url=' + encodeURIComponent(url) + '&apiKey=' + encodeURIComponent(state.apiKey));",
    "    var d = await r.json();",
    "    if (d.error) throw new Error(d.error);",
    "    if (!d.metas || !d.metas.length) throw new Error('No movies or shows found in this list.');",
    "    mdbCatalogPreviewData = { url: url, metas: d.metas, name: d.name, count: d.count };",
    "    if (d.name && !document.getElementById('cc-new-name').value.trim()) document.getElementById('cc-new-name').value = d.name;",
    "    var movieCount = d.metas.filter(function(m){ return m.type === 'movie'; }).length;",
    "    document.getElementById('mdb-cat-type').value = movieCount >= d.metas.length / 2 ? 'movie' : 'series';",
    "    var thumbs = d.metas.slice(0, 8).map(function(m) { if (!m.poster) return ''; return '<img src=\"'+m.poster+'\" style=\"width:36px;height:54px;border-radius:5px;object-fit:cover;\" loading=\"lazy\"/>'; }).join('');",
    "    document.getElementById('mdb-cat-thumbs').innerHTML = thumbs;",
    "    var nameStr = d.name ? ' \u2014 ' + d.name : '';",
    "    status.textContent = d.count + ' item' + (d.count !== 1 ? 's' : '') + ' found' + nameStr; status.style.color = 'var(--gold)';",
    "    preview.style.display = 'block';",
    "  } catch(e) { status.textContent = 'Error: ' + e.message; status.style.color = '#e05252'; }",
    "  finally { btn.disabled = false; btn.textContent = 'Preview'; }",
    "}",
    "function addMdbCatalog() {",
    "  if (!mdbCatalogPreviewData) return;",
    "  var rawName = document.getElementById('cc-new-name').value.trim() || 'MDBList';",
    "  // FIX: strip trailing movie/series/show suffix",
    "  var name = rawName.replace(/\\s+(movies?|series|shows?)$/i, '').trim() || rawName;",
    "  var type = document.getElementById('mdb-cat-type').value;",
    "  var url  = mdbCatalogPreviewData.url;",
    "  state.customCatalogs.push({ id: 'mdblist.' + Date.now(), name: name, type: type, path: '_mdblist_', mdblistUrl: url, enabled: true });",
    "  initUnifiedOrder(); state.unifiedOrder.push({kind:'custom',id:state.customCatalogs[state.customCatalogs.length-1].id});",
    "  document.getElementById('mdb-cat-url').value = '';",
    "  document.getElementById('mdb-cat-preview').style.display = 'none';",
    "  document.getElementById('mdb-cat-status').textContent = '';",
    "  mdbCatalogPreviewData = null;",
    "  var form=document.getElementById('custom-catalog-form');",
    "  form.classList.remove('open');",
    "  document.getElementById('cc-step-name').classList.add('active');",
    "  document.getElementById('cc-step-source').classList.remove('active');",
    "  document.getElementById('cc-new-name').value='';",
    "  renderUnifiedCatalogList();",
    "  showToast('Catalog \\u201c'+name+'\\u201d added');",
    "}",
    "",
    "var imdbCatalogPreviewData = null;",
    "async function previewImdbCatalog() {",
    "  var input = document.getElementById('imdb-cat-url');",
    "  var status = document.getElementById('imdb-cat-status');",
    "  var btn = document.getElementById('imdb-cat-btn');",
    "  var preview = document.getElementById('imdb-cat-preview');",
    "  var url = (input ? input.value : '').trim();",
    "  if (!url) { status.textContent = 'Please enter an IMDB list URL'; status.style.color = '#e05252'; return; }",
    "  btn.disabled = true; btn.innerHTML = '<span class=\"spinner-light\"></span>';",
    "  status.textContent = 'Fetching IMDB list\u2026'; status.style.color = 'var(--text-mute)';",
    "  preview.style.display = 'none'; imdbCatalogPreviewData = null;",
    "  try {",
    "    var r = await fetch('/api/imdb-catalog?url=' + encodeURIComponent(url) + '&apiKey=' + encodeURIComponent(state.apiKey));",
    "    var d = await r.json();",
    "    if (d.error) throw new Error(d.error);",
    "    if (!d.metas || !d.metas.length) throw new Error('No items found in this IMDB list.');",
    "    imdbCatalogPreviewData = { listId: d.listId, url: url, metas: d.metas, name: d.name, count: d.count };",
    "    if (d.name && !document.getElementById('cc-new-name').value.trim()) document.getElementById('cc-new-name').value = d.name;",
    "    var movieCount = d.metas.filter(function(m){ return m.type === 'movie'; }).length;",
    "    document.getElementById('imdb-cat-type').value = movieCount >= d.metas.length / 2 ? 'movie' : 'series';",
    "    var thumbs = d.metas.slice(0, 8).map(function(m) { if (!m.poster) return ''; return '<img src=\"'+m.poster+'\" style=\"width:36px;height:54px;border-radius:5px;object-fit:cover;\" loading=\"lazy\"/>'; }).join('');",
    "    document.getElementById('imdb-cat-thumbs').innerHTML = thumbs;",
    "    var nameStr = d.name ? ' \u2014 ' + d.name : '';",
    "    status.textContent = d.count + ' items found' + nameStr; status.style.color = 'var(--gold)';",
    "    preview.style.display = 'block';",
    "  } catch(e) { status.textContent = 'Error: ' + e.message; status.style.color = '#e05252'; }",
    "  finally { btn.disabled = false; btn.textContent = 'Preview'; }",
    "}",
    "function addImdbCatalog() {",
    "  if (!imdbCatalogPreviewData) return;",
    "  var rawName = document.getElementById('cc-new-name').value.trim() || imdbCatalogPreviewData.name || 'IMDB';",
    "  // FIX: strip trailing movie/series/show suffix",
    "  var name = rawName.replace(/\\s+(movies?|series|shows?)$/i, '').trim() || rawName;",
    "  var type = document.getElementById('imdb-cat-type').value;",
    "  state.customCatalogs.push({ id: 'imdblist.' + Date.now(), name: name, type: type, path: '_imdblist_', imdbListId: imdbCatalogPreviewData.listId, imdbUrl: imdbCatalogPreviewData.url, enabled: true });",
    "  initUnifiedOrder(); state.unifiedOrder.push({kind:'custom',id:state.customCatalogs[state.customCatalogs.length-1].id});",
    "  document.getElementById('imdb-cat-url').value = '';",
    "  document.getElementById('imdb-cat-preview').style.display = 'none';",
    "  document.getElementById('imdb-cat-status').textContent = '';",
    "  document.getElementById('imdb-cat-status').style.color = 'var(--text-mute)';",
    "  imdbCatalogPreviewData = null;",
    "  var form=document.getElementById('custom-catalog-form');",
    "  form.classList.remove('open');",
    "  document.getElementById('cc-step-name').classList.add('active');",
    "  document.getElementById('cc-step-source').classList.remove('active');",
    "  document.getElementById('cc-new-name').value='';",
    "  renderUnifiedCatalogList();",
    "  showToast('Catalog \\u201c'+name+'\\u201d added');",
    "}",
    "",
    "var searchTimer;",
    "function debounceSearch(q) {",
    "  clearTimeout(searchTimer);",
    "  if (!q.trim()) { document.getElementById('search-results').classList.remove('visible'); return; }",
    "  searchTimer=setTimeout(function(){ doSearch(q); },350);",
    "}",
    "async function doSearch(q) {",
    "  var box=document.getElementById('search-results');",
    "  box.classList.add('visible');",
    "  box.innerHTML='<div class=\"loading-state\"><div class=\"spinner-light\"></div> Searching...</div>';",
    "  try {",
    "    var r=await fetch('/api/search?q='+encodeURIComponent(q)+'&apiKey='+encodeURIComponent(state.apiKey)+'&type=tv');",
    "    var d=await r.json();",
    "    if (!d.results||!d.results.length) { box.innerHTML='<p style=\"padding:1rem;font-size:0.82rem;color:var(--text-mute)\">No results.</p>'; return; }",
    "    box.innerHTML=d.results.map(function(s){",
    "      var ph=s.poster?'<img class=\"search-poster\" src=\"'+s.poster+'\" alt=\"\" loading=\"lazy\"/>' : '<div class=\"search-poster\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#128250;</div>';",
    "      return '<div class=\"search-result-item\" onclick=\"addShowToList('+s.id+',\\''+esc4attr(s.name)+'\\',\\''+esc4attr(s.poster||'')+'\\')\">'+ ph +'<div><div class=\"search-name\">'+esc(s.name)+'</div><div class=\"search-meta\">'+(s.year?s.year+' &middot; ':'')+'\u2605 '+s.vote_average+'</div></div></div>';",
    "    }).join('');",
    "  } catch(e) { box.innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">Error searching.</p>'; }",
    "}",
    "",
    "function addShowToList(tmdbId, name, poster) {",
    "  var listId=uid();",
    "  state.customSeasons.push({ listId:listId, tmdbId:String(tmdbId), tmdbName:name, tmdbPoster:poster, label:'Best Of', prefix:'', posterUrl:null, posterSpec:null, posterMode:'default', episodes:[] });",
    "  document.getElementById('search-results').classList.remove('visible');",
    "  document.getElementById('series-search').value='';",
    "  renderCustomSeasonsList();",
    "  setTimeout(function(){ var card=document.getElementById('show-'+listId); if (card) card.classList.add('expanded'); },50);",
    "}",
    "",
    "function getList(listId) { return state.customSeasons.find(function(l){ return l.listId===listId; }); }",
    "",
    "function updateListMeta(listId, field, value) {",
    "  var list=getList(listId); if (list) list[field]=value;",
    "  var nameEl=document.getElementById('show-name-display-'+listId);",
    "  if (nameEl&&list) nameEl.textContent=(list.prefix?list.prefix.trim()+' ':'')+''+(list.label||'Best Of')+' '+list.tmdbName;",
    "}",
    "",
    "function removeList(listId) {",
    "  state.customSeasons=state.customSeasons.filter(function(l){ return l.listId!==listId; });",
    "  renderCustomSeasonsList();",
    "}",
    "",
    "function removeEp(listId, idx) {",
    "  var list=getList(listId); if (!list) return;",
    "  list.episodes.splice(idx,1);",
    "  renderListEpisodes(listId);",
    "  updateEpCount(listId);",
    "}",
    "",
    "function toggleShowCard(listId) { var card=document.getElementById('show-'+listId); if (card) card.classList.toggle('expanded'); }",
    "",
    "function updateEpCount(listId) {",
    "  var list=getList(listId); if (!list) return;",
    "  var badge=document.getElementById('ep-count-'+listId);",
    "  if (badge) {",
    "    badge.textContent=list.episodes.length+' ep'+(list.episodes.length!==1?'s':'');",
    "    badge.className='ep-count-badge'+(list.episodes.length>0?' has-eps':'');",
    "  }",
    "}",
    "",
    "function renderListEpisodes(listId) {",
    "  var list=getList(listId); if (!list) return;",
    "  var el=document.getElementById('eplist-'+listId); if (!el) return;",
    "  if (!list.episodes.length) { el.innerHTML='<li class=\"ep-list-empty\">No episodes yet. Use the tabs above to add some.</li>'; return; }",
    "  el.innerHTML=list.episodes.map(function(ep,i){",
    "    var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'0');",
    "    var th=ep.still?'<img class=\"ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading=\"lazy\"/>':'<div class=\"ep-thumb\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute);font-size:0.8rem\">&#127902;</div>';",
    "    return '<li class=\"ep-item\" data-lid=\"'+listId+'\" data-idx=\"'+i+'\">'+'<span class=\"ep-rank\">'+(i+1)+'</span>'+'<span class=\"ep-drag\" title=\"Drag to reorder\">&#8801;</span>'+th+'<div class=\"ep-info\"><div class=\"ep-label\">S'+sL+'E'+eL+' \u2014 '+esc(ep.name||(\"S\"+sL+\"E\"+eL))+'</div><div class=\"ep-sublabel\">'+(ep.air_date||'')+'</div></div>'+(ep.vote_average>0?'<span class=\"ep-rating\">\u2605'+ep.vote_average.toFixed(1)+'</span>':'')+'<span class=\"ep-del\" onclick=\"removeEp(\\'' + listId + '\\','+i+')\" title=\"Remove\">\u00d7</span></li>';",
    "  }).join('');",
    "  initDragSort(listId);",
    "}",
    "",
    "function renderCustomSeasonsList() {",
    "  var el=document.getElementById('custom-seasons-list');",
    "  if (!state.customSeasons.length) { el.innerHTML='<div class=\"empty-state\">No shows yet. Search above to get started.</div>'; return; }",
    "  el.innerHTML=state.customSeasons.map(function(list){",
    "    var tid=list.listId;",
    "    var effectivePoster=list.posterUrl||list.tmdbPoster||null;",
    "    var ph=effectivePoster?'<img class=\"show-poster\" src=\"'+effectivePoster+'\" alt=\"\" loading=\"lazy\"/>':'<div class=\"show-poster\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#128250;</div>';",
    "    var displayName=(list.prefix?list.prefix.trim()+' ':'')+''+(list.label||'Best Of')+' '+list.tmdbName;",
    "    var hasCnt=list.episodes.length>0;",
    "    var posterMode=list.posterMode||'default';",
    "    var customPosterUrl=(list.posterSpec&&list.posterSpec.mode==='url'?list.posterSpec.url:'')||list.posterUrl||'';",
    "    // Only keep url mode — banner/logo require canvas which is removed",
    "    if(posterMode==='banner'||posterMode==='logo') posterMode='default';",
    "    var posterEditId='poster-edit-'+tid;",
    "    return '<div class=\"show-card\" id=\"show-'+tid+'\">'+",
    "      '<div class=\"show-card-header\">'+ph+'<div class=\"show-card-info\"><div class=\"show-card-name\" id=\"show-name-display-'+tid+'\">'+esc(displayName)+'</div><div class=\"show-card-sub\">'+esc(list.tmdbName)+'</div></div>'+'<div class=\"show-card-actions\">'+",
    "        '<span class=\"ep-count-badge'+(hasCnt?' has-eps':'')+' \" id=\"ep-count-'+tid+'\">'+list.episodes.length+' ep'+(list.episodes.length!==1?'s':'')+'</span>'+",
    "        '<button class=\"btn btn-ghost btn-sm\" style=\"padding:4px 7px;font-size:0.72rem;min-width:unset\" onclick=\"togglePosterEdit(\\'' + tid + '\\')\" title=\"Custom poster\">&#9998;</button>'+",
    "        '<button class=\"btn btn-ghost btn-sm\" onclick=\"toggleShowCard(\\'' + tid + '\\')\" style=\"min-width:32px\">\u22ef</button>'+'</div></div>'+",
    "      // Inline poster URL editor (hidden by default, toggled by edit button)",
    "      '<div id=\"'+posterEditId+'\" style=\"display:none;padding:10px 16px;border-top:1px solid var(--border);background:var(--bg)\">'+",
    "        '<div style=\"font-size:0.7rem;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-mute);margin-bottom:6px\">Custom Poster URL</div>'+",
    "        '<div style=\"display:flex;gap:6px;align-items:center\">'+",
    "          '<input type=\"text\" id=\"custom-poster-url-'+tid+'\" placeholder=\"https://example.com/poster.jpg\" value=\"'+esc(customPosterUrl)+'\" style=\"flex:1;font-size:0.8rem\"/>'+",
    "          '<button class=\"btn btn-primary btn-sm\" onclick=\"applyCustomPosterUrl(\\'' + tid + '\\')\">\u2713</button>'+",
    "          '<button class=\"btn btn-ghost btn-sm\" onclick=\"clearCustomPosterUrl(\\'' + tid + '\\')\">\u00d7</button>'+",
    "        '</div>'+",
    "        '<div style=\"font-size:0.7rem;color:var(--text-mute);margin-top:5px\">Paste any direct image URL to use as the poster for this list.</div>'+",
    "      '</div>'+",
    "      '<div class=\"show-ep-body\">'+",
    "        '<div style=\"padding:14px 16px 0;\">'+",
    "          '<div class=\"show-rename-row\">'+'<input class=\"show-rename-prefix\" type=\"text\" value=\"'+esc(list.prefix||'\u2728')+'\" placeholder=\"\u2728\" oninput=\"updateListMeta(\\'' + tid + '\\',\\'prefix\\',this.value)\" title=\"Prefix emoji\"/>'+'<input class=\"show-rename-label\" type=\"text\" value=\"'+esc(list.label||'Best Of')+'\" placeholder=\"List name\" oninput=\"updateListMeta(\\'' + tid + '\\',\\'label\\',this.value)\"/>'+'<button class=\"btn btn-danger btn-sm\" onclick=\"removeList(\\'' + tid + '\\')\" title=\"Delete\">\u00d7</button></div>'+",
    "        '</div>'+",
    "        '<div class=\"add-tabs\">'+'<button class=\"add-tab active\" id=\"add-tab-picker-'+tid+'\" onclick=\"switchAddTab(\\'' + tid + '\\',\\'picker\\')\">Browse</button>'+'<button class=\"add-tab\" id=\"add-tab-imdb-'+tid+'\" onclick=\"switchAddTab(\\'' + tid + '\\',\\'imdb\\')\">IMDB List</button>'+'<button class=\"add-tab\" id=\"add-tab-paste-'+tid+'\" onclick=\"switchAddTab(\\'' + tid + '\\',\\'paste\\')\">Paste</button></div>'+",
    "        '<div class=\"add-panel active\" id=\"add-panel-picker-'+tid+'\">'+'<button class=\"btn btn-ghost btn-sm\" style=\"width:100%\" onclick=\"openModal(\\'' + tid + '\\')\">&#8984; Browse &amp; select episodes\u2026</button></div>'+",
    "        '<div class=\"add-panel\" id=\"add-panel-imdb-'+tid+'\">'+'<div class=\"import-row\"><input type=\"text\" id=\"imdb-url-'+tid+'\" placeholder=\"https://www.imdb.com/list/ls086682535/\" onkeydown=\"if(event.key===\\'Enter\\') importImdbList(\\'' + tid + '\\')\"/><button class=\"btn btn-ghost btn-sm\" id=\"imdb-btn-'+tid+'\" onclick=\"importImdbList(\\'' + tid + '\\')\">\u2193 Import</button></div><div class=\"import-status\" id=\"imdb-status-'+tid+'\"></div></div>'+",
    "        '<div class=\"add-panel\" id=\"add-panel-paste-'+tid+'\">'+'<p class=\"paste-hint\">Accepts S01E01, s1e1, 1x01 formats. One per line or space-separated.</p>'+'<textarea id=\"paste-input-'+tid+'\" placeholder=\"S01E01\\nS01E05\\nS02E03\"></textarea>'+'<div class=\"paste-actions\"><button class=\"btn btn-primary btn-sm\" onclick=\"applyPaste(\\'' + tid + '\\')\">\u2713 Add Episodes</button><span class=\"paste-status\" id=\"paste-status-'+tid+'\"></span></div></div>'+",
    "        '<div style=\"padding:0 16px 16px;\">'+'<ul class=\"ep-list mt-2\" id=\"eplist-'+tid+'\"><li class=\"ep-list-empty\">No episodes yet. Use the tabs above to add some.</li></ul></div>'+",
    "      '</div>'+'</div>';",
    "  }).join('');",
    "  state.customSeasons.forEach(function(list){ renderListEpisodes(list.listId); initDragSort(list.listId); });",
    "}",
    "",
    "function togglePosterEdit(listId) {",
    "  var el=document.getElementById('poster-edit-'+listId); if(!el) return;",
    "  el.style.display=el.style.display==='none'?'block':'none';",
    "}",
    "function clearCustomPosterUrl(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  var inp=document.getElementById('custom-poster-url-'+listId); if(inp) inp.value='';",
    "  list.posterUrl=null; list.posterSpec=null; list.posterMode='default';",
    "  updateShowPosterThumb(listId);",
    "}",
    "",
    "function updateBannerOpacityLabel(listId, input) {",
    "  var list=getList(listId); if(!list) return;",
    "  list.bannerOpacity=parseFloat(input.value);",
    "  var label=input.parentElement&&input.parentElement.querySelector('label');",
    "  if(label) label.textContent='Opacity '+Math.round(list.bannerOpacity*100)+'%';",
    "}",
    "",
    "function updateBannerOption(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  var panel=document.getElementById('pmp-banner-'+listId); if(!panel) return;",
    "  var sel=panel.querySelector('select'); if(sel) list.bannerPos=sel.value;",
    "  var bcolor=document.getElementById('bcolor-'+listId); if(bcolor) list.bannerColor=bcolor.value;",
    "  var btcolor=document.getElementById('btcolor-'+listId); if(btcolor) list.bannerTextColor=btcolor.value;",
    "}",
    "",
    "async function generateBannerPoster(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  updateBannerOption(listId);",
    "  var statusEl=document.getElementById('banner-status-'+listId);",
    "  if(statusEl) statusEl.textContent='Generating\u2026';",
    "  var basePoster=list.tmdbPoster||null;",
    "  if(!basePoster){if(statusEl)statusEl.textContent='No poster available.';return;}",
    "  var label=(list.label||'Best Of');",
    "  var pos=list.bannerPos||'bottom';",
    "  var barColor=list.bannerColor||'#000000';",
    "  var opacity=list.bannerOpacity!=null?list.bannerOpacity:0.75;",
    "  var textColor=list.bannerTextColor||'#ffffff';",
    "  // Store posterSpec (compact) — server generates the actual poster URL",
    "  list.posterSpec={mode:'banner',pos:pos,barColor:barColor,opacity:opacity,textColor:textColor};",
    "  list.posterMode='banner';",
    "  // Also try to generate a client-side preview",
    "  try {",
    "    var dataUrl=await drawBannerPoster(basePoster,label,pos,barColor,opacity,textColor);",
    "    list.posterUrl=dataUrl; // preview only, not stored in final config",
    "    updateShowPosterThumb(listId);",
    "    if(statusEl)statusEl.textContent='\u2713 Applied';",
    "    setTimeout(function(){if(statusEl)statusEl.textContent='';},2500);",
    "  } catch(e) {",
    "    // Preview failed (CORS etc.) but posterSpec is still saved — server will render it",
    "    if(statusEl)statusEl.textContent='\u2713 Saved (preview unavailable)';",
    "    setTimeout(function(){if(statusEl)statusEl.textContent='';},3000);",
    "  }",
    "}",
    "",
    "async function generateLogoPoster(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  var statusEl=document.getElementById('logo-status-'+listId);",
    "  if(statusEl) statusEl.textContent='Fetching logo\u2026';",
    "  try {",
    "    var r=await fetch('/api/series-logo?tmdbId='+list.tmdbId+'&apiKey='+encodeURIComponent(state.apiKey));",
    "    var d=await r.json();",
    "    var bgColor=list.logoBgColor||'#111111';",
    "    var textColor=list.logoTextColor||'#ffffff';",
    "    var label=(list.label||'Best Of');",
    "    // Store posterSpec (compact) — server generates the actual poster URL",
    "    list.posterSpec={mode:'logo',bgColor:bgColor,textColor:textColor};",
    "    list.posterMode='logo';",
    "    var dataUrl=await drawLogoPoster(d.logoUrl||null,label,bgColor,textColor,list.tmdbName);",
    "    list.posterUrl=dataUrl; // preview only",
    "    updateShowPosterThumb(listId);",
    "    if(statusEl)statusEl.textContent='\u2713 Applied';",
    "    setTimeout(function(){if(statusEl)statusEl.textContent='';},2500);",
    "  } catch(e) { if(statusEl)statusEl.textContent='Error: '+e.message; }",
    "}",
    "",
    "function applyCustomPosterUrl(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  var inp=document.getElementById('custom-poster-url-'+listId); if(!inp) return;",
    "  var url=inp.value.trim();",
    "  list.posterUrl=url||null;",
    "  list.posterSpec=url?{mode:'url',url:url}:null;",
    "  list.posterMode=url?'url':'default';",
    "  updateShowPosterThumb(listId);",
    "}",
    "",
    "function updateShowPosterThumb(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  var header=document.querySelector('#show-'+listId+' .show-card-header');",
    "  if(!header) return;",
    "  var effectivePoster=list.posterUrl||list.tmdbPoster||null;",
    "  var ph=header.querySelector('.show-poster');",
    "  if(ph&&effectivePoster){",
    "    if(ph.tagName==='IMG'){ph.src=effectivePoster;}",
    "    else{var img=document.createElement('img');img.className='show-poster';img.src=effectivePoster;img.alt='';img.loading='lazy';ph.parentNode.replaceChild(img,ph);}",
    "  }",
    "}",
    "",
    "function loadImageAsDataUrl(src) {",
    "  return new Promise(function(resolve,reject){",
    "    var img=new Image();",
    "    img.crossOrigin='anonymous';",
    "    img.onload=function(){resolve(img);};",
    "    img.onerror=function(){reject(new Error('Failed to load image: '+src));};",
    "    img.src=src;",
    "  });",
    "}",
    "",
    "async function drawBannerPoster(posterSrc,label,position,barColor,opacity,textColor) {",
    "  // Proxy through our server to avoid CORS blocking on canvas.drawImage",
    "  var proxySrc = posterSrc;",
    "  if (posterSrc && posterSrc.includes('image.tmdb.org')) {",
    "    var pathMatch = posterSrc.match(/\\/p\\/[^/]+(\\/[^?#]+)/);",
    "    if (pathMatch) proxySrc = '/api/proxy-img?path=' + encodeURIComponent(pathMatch[1]);",
    "  }",
    "  var img=await loadImageAsDataUrl(proxySrc);",
    "  var W=342,H=513;",
    "  var canvas=document.createElement('canvas');",
    "  canvas.width=W; canvas.height=H;",
    "  var ctx=canvas.getContext('2d');",
    "  ctx.drawImage(img,0,0,W,H);",
    "  var barH=Math.round(H*0.14);",
    "  var barY=position==='top'?0:H-barH;",
    "  // Parse barColor hex to rgba",
    "  var r=parseInt(barColor.slice(1,3),16),g=parseInt(barColor.slice(3,5),16),b=parseInt(barColor.slice(5,7),16);",
    "  ctx.fillStyle='rgba('+r+','+g+','+b+','+opacity+')';",
    "  ctx.fillRect(0,barY,W,barH);",
    "  // Draw text",
    "  var fontSize=Math.round(barH*0.32);",
    "  ctx.fillStyle=textColor;",
    "  ctx.font='600 '+fontSize+'px system-ui,sans-serif';",
    "  ctx.textAlign='center';",
    "  ctx.textBaseline='middle';",
    "  // Word wrap if needed",
    "  var maxWidth=W-24;",
    "  var words=label.split(' ');",
    "  var lines=[]; var line='';",
    "  for(var i=0;i<words.length;i++){",
    "    var test=(line?line+' ':'')+words[i];",
    "    if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=words[i];}",
    "    else line=test;",
    "  }",
    "  if(line) lines.push(line);",
    "  var lineH=fontSize*1.2;",
    "  var totalTextH=lines.length*lineH;",
    "  var startY=barY+(barH-totalTextH)/2+lineH/2;",
    "  for(var j=0;j<lines.length;j++){ctx.fillText(lines[j],W/2,startY+j*lineH);}",
    "  return canvas.toDataURL('image/jpeg',0.92);",
    "}",
    "",
    "async function drawLogoPoster(logoSrc,label,bgColor,textColor,seriesName) {",
    "  var W=342,H=513;",
    "  var canvas=document.createElement('canvas');",
    "  canvas.width=W; canvas.height=H;",
    "  var ctx=canvas.getContext('2d');",
    "  // Background",
    "  ctx.fillStyle=bgColor;",
    "  ctx.fillRect(0,0,W,H);",
    "  // Subtle gradient overlay",
    "  var grad=ctx.createRadialGradient(W/2,H*0.35,10,W/2,H*0.35,W*0.7);",
    "  grad.addColorStop(0,'rgba(255,255,255,0.07)');",
    "  grad.addColorStop(1,'rgba(0,0,0,0)');",
    "  ctx.fillStyle=grad;",
    "  ctx.fillRect(0,0,W,H);",
    "  // Logo image centered in upper 60%",
    "  if(logoSrc){",
    "    try{",
    "      var logoImg=await loadImageAsDataUrl(logoSrc);",
    "      var lW=W-60,lH=Math.round(H*0.25);",
    "      var scale=Math.min(lW/logoImg.naturalWidth,lH/logoImg.naturalHeight);",
    "      var dW=logoImg.naturalWidth*scale,dH=logoImg.naturalHeight*scale;",
    "      ctx.drawImage(logoImg,(W-dW)/2,(H*0.28-dH/2),dW,dH);",
    "    }catch(e){",
    "      // fallback: draw series name as big text",
    "      ctx.fillStyle=textColor;",
    "      ctx.font='bold '+Math.round(W*0.09)+'px system-ui,sans-serif';",
    "      ctx.textAlign='center';ctx.textBaseline='middle';",
    "      ctx.fillText(seriesName,W/2,H*0.32);",
    "    }",
    "  } else {",
    "    ctx.fillStyle=textColor;",
    "    ctx.font='bold '+Math.round(W*0.09)+'px system-ui,sans-serif';",
    "    ctx.textAlign='center';ctx.textBaseline='middle';",
    "    ctx.fillText(seriesName,W/2,H*0.32);",
    "  }",
    "  // Divider line",
    "  ctx.strokeStyle='rgba(255,255,255,0.15)';",
    "  ctx.lineWidth=1;",
    "  ctx.beginPath();ctx.moveTo(40,H*0.58);ctx.lineTo(W-40,H*0.58);ctx.stroke();",
    "  // Label text",
    "  ctx.fillStyle=textColor;",
    "  ctx.textAlign='center';ctx.textBaseline='middle';",
    "  var fontSize=Math.round(W*0.065);",
    "  ctx.font='600 '+fontSize+'px system-ui,sans-serif';",
    "  var maxWidth=W-48;",
    "  var words=label.split(' ');",
    "  var lines2=[]; var line2='';",
    "  for(var i=0;i<words.length;i++){",
    "    var test=(line2?line2+' ':'')+words[i];",
    "    if(ctx.measureText(test).width>maxWidth&&line2){lines2.push(line2);line2=words[i];}",
    "    else line2=test;",
    "  }",
    "  if(line2) lines2.push(line2);",
    "  var lineH2=fontSize*1.35;",
    "  var totalH=lines2.length*lineH2;",
    "  var startY2=H*0.72-totalH/2+lineH2/2;",
    "  for(var j=0;j<lines2.length;j++){ctx.fillText(lines2[j],W/2,startY2+j*lineH2);}",
    "  return canvas.toDataURL('image/jpeg',0.92);",
    "}",
    "",
    "function initDragSort(listId) {",
    "  var listEl = document.getElementById('eplist-'+listId);",
    "  if (!listEl) return;",
    "  var dragIdx = null;",
    "  listEl.querySelectorAll('.ep-item').forEach(function(item, idx) {",
    "    item.setAttribute('draggable', 'true');",
    "    item.addEventListener('dragstart', function(e) { dragIdx = parseInt(item.dataset.idx); item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });",
    "    item.addEventListener('dragend', function() { item.classList.remove('dragging'); listEl.querySelectorAll('.ep-item').forEach(function(i) { i.classList.remove('drag-over'); }); });",
    "    item.addEventListener('dragover', function(e) { e.preventDefault(); listEl.querySelectorAll('.ep-item').forEach(function(i) { i.classList.remove('drag-over'); }); item.classList.add('drag-over'); });",
    "    item.addEventListener('dragleave', function() { item.classList.remove('drag-over'); });",
    "    item.addEventListener('drop', function(e) { e.preventDefault(); item.classList.remove('drag-over'); var dropIdx = parseInt(item.dataset.idx); if (dragIdx === null || dragIdx === dropIdx) return; var list = getList(listId); if (!list) return; var moved = list.episodes.splice(dragIdx, 1)[0]; list.episodes.splice(dropIdx, 0, moved); renderListEpisodes(listId); updateEpCount(listId); });",
    "  });",
    "  var touchDragIdx = null; var touchClone = null; var touchOffsetY = 0;",
    "  listEl.querySelectorAll('.ep-drag').forEach(function(handle) {",
    "    handle.addEventListener('touchstart', function(e) { var item = handle.closest('.ep-item'); if (!item) return; touchDragIdx = parseInt(item.dataset.idx); var touch = e.touches[0]; var rect = item.getBoundingClientRect(); touchOffsetY = touch.clientY - rect.top; touchClone = item.cloneNode(true); touchClone.style.cssText = 'position:fixed;left:'+rect.left+'px;top:'+rect.top+'px;width:'+rect.width+'px;opacity:0.85;z-index:9999;pointer-events:none;border:1px solid var(--gold);border-radius:9px;background:var(--bg);box-shadow:0 8px 32px rgba(0,0,0,0.5);'; document.body.appendChild(touchClone); item.style.opacity = '0.3'; e.preventDefault(); }, { passive: false });",
    "    handle.addEventListener('touchmove', function(e) { if (touchDragIdx === null || !touchClone) return; var touch = e.touches[0]; touchClone.style.top = (touch.clientY - touchOffsetY) + 'px'; var targetEl = document.elementFromPoint(touch.clientX, touch.clientY); listEl.querySelectorAll('.ep-item').forEach(function(i) { i.classList.remove('drag-over'); }); var targetItem = targetEl ? targetEl.closest('.ep-item') : null; if (targetItem && targetItem.dataset.lid === listId) targetItem.classList.add('drag-over'); e.preventDefault(); }, { passive: false });",
    "    handle.addEventListener('touchend', function(e) { if (touchDragIdx === null) return; var touch = e.changedTouches[0]; var targetEl = document.elementFromPoint(touch.clientX, touch.clientY); var targetItem = targetEl ? targetEl.closest('.ep-item') : null; if (touchClone) { document.body.removeChild(touchClone); touchClone = null; } listEl.querySelectorAll('.ep-item').forEach(function(i) { i.style.opacity=''; i.classList.remove('drag-over'); }); if (targetItem && targetItem.dataset.lid === listId) { var dropIdx = parseInt(targetItem.dataset.idx); if (dropIdx !== touchDragIdx) { var list = getList(listId); if (list) { var moved = list.episodes.splice(touchDragIdx, 1)[0]; list.episodes.splice(dropIdx, 0, moved); renderListEpisodes(listId); updateEpCount(listId); } } } touchDragIdx = null; });",
    "  });",
    "}",
    "",
    "async function openModal(listId) {",
    "  var list=getList(listId); if (!list) return;",
    "  modalData.listId=listId; modalData.tmdbId=list.tmdbId;",
    "  modalData.allEpisodes=[]; modalData.filteredSeason='all';",
    "  modalData.selected=new Set(list.episodes.map(function(e){ return e.season+':'+e.episode; }));",
    "  document.getElementById('modal-show-name').textContent=list.tmdbName;",
    "  document.getElementById('modal-show-sub').textContent='Loading...';",
    "  document.getElementById('modal-poster').src=list.tmdbPoster||'';",
    "  document.getElementById('modal-season-filters').innerHTML='';",
    "  document.getElementById('modal-ep-list').innerHTML='<div class=\"loading-state\"><div class=\"spinner-light\"></div> Loading...</div>';",
    "  updateModalCount();",
    "  document.getElementById('modal-backdrop').classList.add('open');",
    "  document.body.style.overflow='hidden';",
    "  try {",
    "    var r=await fetch('/api/episodes?tmdbId='+list.tmdbId+'&apiKey='+encodeURIComponent(state.apiKey));",
    "    var d=await r.json();",
    "    if (d.error) throw new Error(d.error);",
    "    modalData.allEpisodes=d.episodes;",
    "    document.getElementById('modal-show-sub').textContent=d.show.seasons+' season'+(d.show.seasons!==1?'s':'')+' \u2014 '+d.episodes.length+' episodes';",
    "    var seasons=[]; d.episodes.forEach(function(e){ if (seasons.indexOf(e.season)===-1) seasons.push(e.season); }); seasons.sort(function(a,b){return a-b;});",
    "    var filters=document.getElementById('modal-season-filters');",
    "    var btns=['<button class=\"season-btn active\" onclick=\"setSeasonFilter(\\'all\\',this)\">All</button>'];",
    "    seasons.forEach(function(s){ btns.push('<button class=\"season-btn\" onclick=\"setSeasonFilter('+s+',this)\">S'+s+'</button>'); });",
    "    filters.innerHTML=btns.join('');",
    "    renderModalEpisodes();",
    "  } catch(e) { document.getElementById('modal-ep-list').innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">Error: '+esc(e.message)+'</p>'; }",
    "}",
    "function setSeasonFilter(val,btn) { modalData.filteredSeason=val; document.querySelectorAll('.season-btn').forEach(function(b){ b.classList.remove('active'); }); btn.classList.add('active'); renderModalEpisodes(); }",
    "function renderModalEpisodes() {",
    "  var eps=modalData.filteredSeason==='all'?modalData.allEpisodes:modalData.allEpisodes.filter(function(e){ return e.season===modalData.filteredSeason; });",
    "  var list=document.getElementById('modal-ep-list');",
    "  if (!eps.length) { list.innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">No episodes.</p>'; return; }",
    "  list.innerHTML=eps.map(function(ep){ var key=ep.season+':'+ep.episode; var sel=modalData.selected.has(key); var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'0'); var th=ep.still?'<img class=\"modal-ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading=\"lazy\"/>':'<div class=\"modal-ep-thumb\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#127902;</div>'; return '<div class=\"modal-ep-item'+(sel?' selected':'')+' \" onclick=\"toggleEp(\\'' + key + '\\',this)\">'+th+'<div class=\"modal-ep-info\"><div class=\"modal-ep-name\">S'+sL+'E'+eL+' \u2014 '+esc(ep.name)+'</div><div class=\"modal-ep-meta\">'+(ep.vote_average>0?'\u2605 '+ep.vote_average.toFixed(1)+' &middot; ':'')+(ep.air_date||'')+'</div></div><div class=\"modal-ep-check\">'+(sel?'&#10003;':'')+'</div></div>'; }).join('');",
    "}",
    "function toggleEp(key,el) { if (modalData.selected.has(key)){ modalData.selected.delete(key); el.classList.remove('selected'); el.querySelector('.modal-ep-check').innerHTML=''; } else { modalData.selected.add(key); el.classList.add('selected'); el.querySelector('.modal-ep-check').innerHTML='&#10003;'; } updateModalCount(); }",
    "function updateModalCount() { document.getElementById('modal-sel-count').textContent=modalData.selected.size; }",
    "function addSelectedEpisodes() {",
    "  var list=getList(modalData.listId); if(!list){ closeModal(); return; }",
    "  // Build the set of all visible episode keys in the modal",
    "  var visibleKeys=new Set(modalData.allEpisodes.map(function(e){ return e.season+':'+e.episode; }));",
    "  // Keep existing episodes that were NOT shown in this modal session (untouched)",
    "  var untouched=list.episodes.filter(function(e){ return !visibleKeys.has(e.season+':'+e.episode); });",
    "  // From visible episodes, keep those the user left selected (preserve existing data like stills)",
    "  var prevVisibleSelected=list.episodes.filter(function(e){",
    "    return visibleKeys.has(e.season+':'+e.episode)&&modalData.selected.has(e.season+':'+e.episode);",
    "  });",
    "  var prevSelectedKeys=new Set(prevVisibleSelected.map(function(e){ return e.season+':'+e.episode; }));",
    "  // Add newly selected episodes (not previously in the list)",
    "  var newlyAdded=Array.from(modalData.selected).map(function(k){",
    "    if (prevSelectedKeys.has(k)) return null;",
    "    var p=k.split(':').map(Number);",
    "    return modalData.allEpisodes.find(function(ep){ return ep.season===p[0]&&ep.episode===p[1]; });",
    "  }).filter(Boolean);",
    "  list.episodes=untouched.concat(prevVisibleSelected).concat(newlyAdded);",
    "  closeModal(); renderListEpisodes(modalData.listId); updateEpCount(modalData.listId);",
    "}",
    "function closeModal(){ document.getElementById('modal-backdrop').classList.remove('open'); document.body.style.overflow=''; }",
    "function closeModalOnBackdrop(e){ if(e.target===document.getElementById('modal-backdrop')) closeModal(); }",
    "",
    "async function importImdbList(listId) {",
    "  var list = getList(listId); if (!list) return;",
    "  var input = document.getElementById('imdb-url-'+listId);",
    "  var status = document.getElementById('imdb-status-'+listId);",
    "  var btn = document.getElementById('imdb-btn-'+listId);",
    "  var url = (input ? input.value : '').trim();",
    "  if (!url) { if(status){status.textContent='Please enter an IMDB list URL'; status.className='import-status err';} return; }",
    "  if (btn){btn.disabled=true;btn.innerHTML='<span class=\"spinner-light\"></span>';}",
    "  if (status){status.textContent='Fetching\u2026'; status.className='import-status';}",
    "  try {",
    "    var r=await fetch('/api/imdb-list?url='+encodeURIComponent(url)+'&apiKey='+encodeURIComponent(state.apiKey)+'&tmdbId='+list.tmdbId);",
    "    var d=await r.json();",
    "    if (d.error) throw new Error(d.error);",
    "    if (!d.episodes||!d.episodes.length) throw new Error('No matching episodes found for this show.');",
    "    var existingKeys=new Set(list.episodes.map(function(e){ return e.season+':'+e.episode; }));",
    "    var allEpsForShow=modalData.tmdbId===list.tmdbId?modalData.allEpisodes:[];",
    "    var added=0;",
    "    for (var i=0;i<d.episodes.length;i++){ var ref=d.episodes[i]; var key=ref.season+':'+ref.episode; if (!existingKeys.has(key)){ existingKeys.add(key); var full=allEpsForShow.find(function(e){ return e.season===ref.season&&e.episode===ref.episode; }); list.episodes.push(full||ref); added++; } }",
    "    var msg='Added '+added+' episode'+(added!==1?'s':''); if (d.skipped) msg+=' ('+d.skipped+' not found)';",
    "    if (status){status.textContent=msg; status.className='import-status ok';} if (input) input.value='';",
    "    renderListEpisodes(listId); updateEpCount(listId);",
    "  } catch(e) { if (status){status.textContent='Error: '+e.message; status.className='import-status err';} }",
    "  finally { if(btn){btn.disabled=false;btn.innerHTML='\u2193 Import';} }",
    "}",
    "",
    "function toggleSzeroExpand() { var card = document.getElementById('szero-card'); if (card) card.classList.toggle('expanded'); }",
    "",
    "// ── Client-side compression ──────────────────────────────────────────────",
    "async function compressToBase64url(str) {",
    "  try {",
    "    var bytes = new TextEncoder().encode(str);",
    "    var cs = new CompressionStream('deflate-raw');",
    "    var writer = cs.writable.getWriter();",
    "    var reader = cs.readable.getReader();",
    "    writer.write(bytes); writer.close();",
    "    var chunks = []; var done = false;",
    "    while (!done) { var chunk = await reader.read(); if (chunk.done) done=true; else chunks.push(chunk.value); }",
    "    var total = chunks.reduce(function(a,c){return a+c.length;},0);",
    "    var merged = new Uint8Array(total); var offset=0;",
    "    chunks.forEach(function(c){ merged.set(c,offset); offset+=c.length; });",
    "    var binary = Array.from(merged).map(function(b){return String.fromCharCode(b);}).join('');",
    "    return btoa(binary).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');",
    "  } catch(e) {",
    "    return btoa(unescape(encodeURIComponent(str))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');",
    "  }",
    "}",
    "",
    "function buildConfigFlat(includeKey) {",
    "  var flat=state.customSeasons.map(function(list){",
    "    var posterSpec=null; var mode=list.posterMode||'default';",
    "    if(mode==='banner'){ posterSpec={mode:'banner',pos:list.bannerPos||'bottom',barColor:list.bannerColor||'#000000',opacity:list.bannerOpacity!=null?list.bannerOpacity:0.75,textColor:list.bannerTextColor||'#ffffff'}; }",
    "    else if(mode==='logo'){ posterSpec={mode:'logo',bgColor:list.logoBgColor||'#111111',textColor:list.logoTextColor||'#ffffff'}; }",
    "    else if(mode==='url'&&list.posterUrl&&!list.posterUrl.startsWith('data:')){ posterSpec={mode:'url',url:list.posterUrl}; }",
    "    return { listId:list.listId, tmdbId:list.tmdbId, tmdbName:list.tmdbName||'', label:list.label||'Best Of', prefix:list.prefix||'', posterSpec:posterSpec, episodes:list.episodes.map(function(e){ return {season:e.season,episode:e.episode}; }) };",
    "  });",
    "  var cfg={topN:state.topN, showAutoSeason:state.showAutoSeason, customSeasons:flat, catalogEnabled:state.catalogEnabled, catalogNames:state.catalogNames, customCatalogs:state.customCatalogs, defaultCatalogOrder:state.unifiedOrder};",
    "  if(includeKey) cfg.tmdbApiKey=state.apiKey;",
    "  return cfg;",
    "}",
    "",
    "function buildInstallPage() {",
    "  state.topN=parseInt(document.getElementById('topN').value)||20;",
    "  state.showAutoSeason=document.getElementById('showAutoSeason').checked;",
    "  var manifestUrlEl=document.getElementById('manifest-url');",
    "  var editUrlEl=document.getElementById('edit-url');",
    "  // Immediate fallback: uncompressed inline base64 (with key, legacy format)",
    "  var cfgFull=buildConfigFlat(true);",
    "  var b64=btoa(unescape(encodeURIComponent(JSON.stringify(cfgFull))));",
    "  manifestUrlEl.value=window.location.origin+'/'+b64+'/manifest.json';",
    "  editUrlEl.value=window.location.origin+'/'+b64+'/configure';",
    "  // Async: save key-stripped config, encode key separately, build short URL",
    "  (async function(){",
    "    try {",
    "      var cfgNoKey=buildConfigFlat(false);",
    "      // Key token: compressed base64url of just the key data — never sent to server",
    "      var keyData={tmdbApiKey:state.apiKey,topN:state.topN,showAutoSeason:state.showAutoSeason};",
    "      var keyToken=await compressToBase64url(JSON.stringify(keyData));",
    "      var r=await fetch('/api/save-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfgNoKey)});",
    "      var d=await r.json();",
    "      if(d.id){",
    "        manifestUrlEl.value=window.location.origin+'/s/'+d.id+'/'+keyToken+'/manifest.json';",
    "        editUrlEl.value=window.location.origin+'/s/'+d.id+'/'+keyToken+'/configure';",
    "      }",
    "    } catch(e){}",
    "  })();",
    "  var listCount=state.customSeasons.length;",
    "  var showCount=new Set(state.customSeasons.map(function(l){ return l.tmdbId; })).size;",
    "  var enabledDefaultCount=DEFAULT_CATALOGS.filter(function(d){ var ov=state.catalogEnabled[d.id]; return ov!==undefined?ov:d.enabled; }).length;",
    "  var customCatCount=state.customCatalogs.length;",
    "  document.getElementById('install-summary').innerHTML=",
    "    '<div class=\"summary-row\"><span class=\"summary-label\">Default catalogs</span><span class=\"summary-value accent\">'+enabledDefaultCount+' enabled</span></div>'+",
    "    '<div class=\"summary-row\"><span class=\"summary-label\">Custom catalogs</span><span class=\"summary-value\">'+(customCatCount>0?customCatCount:'None')+'</span></div>'+",
    "    '<div class=\"summary-row\"><span class=\"summary-label\">Season Zero</span><span class=\"summary-value\">'+(state.showAutoSeason?'On \u00b7 top '+state.topN:'Off')+'</span></div>'+",
    "    '<div class=\"summary-row\" style=\"margin-bottom:1.4rem\"><span class=\"summary-label\">Curated lists</span><span class=\"summary-value accent\">'+(listCount>0?listCount+' list'+(listCount!==1?'s':'')+' across '+showCount+' show'+(showCount!==1?'s':''):'None')+'</span></div>';",
    "  var allThumbs=[];",
    "  state.customSeasons.forEach(function(list){ list.episodes.forEach(function(ep){ allThumbs.push(ep.still||null); }); });",
    "  if (allThumbs.length) {",
    "    var thumbsHtml=allThumbs.concat(allThumbs).map(function(src){ return src?'<img class=\"parade-thumb\" src=\"'+src+'\" alt=\"\" loading=\"lazy\"/>' : '<div class=\"parade-thumb no-img\">&#127902;</div>'; }).join('');",
    "    document.getElementById('ep-parade').innerHTML='<div class=\"ep-parade-track\">'+thumbsHtml+'</div>';",
    "    document.getElementById('ep-parade').style.display='flex';",
    "  } else { document.getElementById('ep-parade').style.display='none'; }",
    "}",
    "",
    "function openStremio(){ var url=document.getElementById('manifest-url').value; if(!url) return; window.location.href=url.replace(/^https?:\\/\\//,'stremio://'); }",
    "function copyUrl(inputId, btnId) {",
    "  var input=document.getElementById(inputId||'manifest-url');",
    "  input.select();",
    "  try{document.execCommand('copy');}catch(e){navigator.clipboard&&navigator.clipboard.writeText(input.value);}",
    "  var btn=document.getElementById(btnId||'copy-btn');",
    "  btn.textContent='Copied!'; btn.classList.add('copied');",
    "  setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied');},2000);",
    "}",
    "",
    "function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }",
    "function esc4attr(s){ return String(s||'').replace(/'/g,'&#39;'); }",
    "",
    "// ── Toast notification ──",
    "function showToast(msg) {",
    "  var t=document.getElementById('gt-toast');",
    "  if(!t){t=document.createElement('div');t.id='gt-toast';t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a1a;border:1px solid var(--border2);color:var(--text);font-size:0.82rem;padding:10px 20px;border-radius:30px;z-index:9999;transition:opacity 0.3s;pointer-events:none;white-space:nowrap;font-family:DM Sans,sans-serif';document.body.appendChild(t);}",
    "  t.textContent=msg; t.style.opacity='1';",
    "  clearTimeout(t._timer);",
    "  t._timer=setTimeout(function(){t.style.opacity='0';},2200);",
    "}",
    "",
    "// ── Boost Gallery ──",
    "var boostData = [];",
    "async function loadBoostGallery() {",
    "  var el=document.getElementById('boost-gallery-cards'); if(!el) return;",
    "  el.innerHTML='<div class=\"loading-state\"><div class=\"spinner-light\"></div> Loading boosts\u2026</div>';",
    "  try {",
    "    var r=await fetch('/api/boosts');",
    "    var d=await r.json();",
    "    boostData=d.boosts||[];",
    "    if(!boostData.length){el.innerHTML='<p style=\"font-size:0.82rem;color:var(--text-mute)\">No boost presets available.</p>';return;}",
    "    el.innerHTML=boostData.map(function(b,i){",
    "      return '<div class=\"boost-card\" id=\"boost-'+b.id+'\">'+",
    "        '<div class=\"boost-card-header\">'+",
    "          '<div class=\"boost-emoji\">'+esc(b.emoji||'⚡')+'</div>'+",
    "          '<div class=\"boost-info\">'+",
    "            '<div class=\"boost-name\">'+esc(b.name)+'</div>'+",
    "            '<div class=\"boost-meta\">'+b.catalogCount+' catalog'+(b.catalogCount!==1?'s':'')+(b.listCount?' &middot; '+b.listCount+' list'+(b.listCount!==1?'s':''):'')+'</div>'+",
    "          '</div>'+",
    "        '</div>'+",
    "        '<div class=\"boost-desc\">'+esc(b.description)+'</div>'+",
    "        '<div class=\"boost-previews\" id=\"boost-prev-'+b.id+'\"><div style=\"font-size:0.7rem;color:var(--text-mute)\">Loading previews\u2026</div></div>'+",
    "        '<button class=\"btn btn-primary btn-sm boost-btn\" onclick=\"applyBoost(\\''+b.id+'\\')\">'+'Apply Boost'+'</button>'+",
    "      '</div>';",
    "    }).join('');",
    "    // Load previews in parallel",
    "    boostData.forEach(function(b){",
    "      if(state.apiKey) loadBoostPreviews(b.id);",
    "      else { var prev=document.getElementById('boost-prev-'+b.id); if(prev) prev.innerHTML='<div style=\"font-size:0.7rem;color:var(--text-mute)\">Add API key to see previews</div>'; }",
    "    });",
    "    // Mark boosts that are already applied (from loaded config)",
    "    var appliedBoostIds=new Set();",
    "    state.customCatalogs.forEach(function(c){ if(c._boostId) appliedBoostIds.add(c._boostId); });",
    "    state.customSeasons.forEach(function(s){ if(s._boostId) appliedBoostIds.add(s._boostId); });",
    "    appliedBoostIds.forEach(function(boostId){",
    "      var btn=document.querySelector('#boost-'+boostId+' .boost-btn');",
    "      if(btn){ btn.classList.add('boost-applied'); btn.innerHTML='&#10003; Applied \u2014 click to remove'; }",
    "    });",
    "    if(appliedBoostIds.size>0){",
    "      var skipBtn=document.getElementById('boost-skip-btn');",
    "      if(skipBtn){skipBtn.innerHTML='Continue &rarr;';skipBtn.className='btn btn-primary';}",
    "    }",
    "  } catch(e) { el.innerHTML='<p style=\"font-size:0.82rem;color:var(--text-mute)\">Could not load boosts.</p>'; }",
    "}",
    "",
    "async function loadBoostPreviews(boostId) {",
    "  var prev=document.getElementById('boost-prev-'+boostId); if(!prev) return;",
    "  try {",
    "    var r=await fetch('/api/boost-previews?boostId='+encodeURIComponent(boostId)+'&apiKey='+encodeURIComponent(state.apiKey));",
    "    var d=await r.json();",
    "    if(!d.posters||!d.posters.length){prev.innerHTML='';return;}",
    "    prev.innerHTML=d.posters.map(function(p){ return '<img class=\"boost-preview-poster\" src=\"'+p+'\" alt=\"\" loading=\"lazy\"/>'; }).join('');",
    "  } catch(e){prev.innerHTML='';}",
    "}",
    "",
    "async function applyBoost(boostId) {",
    "  var btn = document.querySelector('#boost-'+boostId+' .boost-btn');",
    "  var wasApplied = btn && btn.classList.contains('boost-applied');",
    "  try {",
    "    var r=await fetch('/api/boosts/'+encodeURIComponent(boostId));",
    "    var d=await r.json();",
    "    var boost=d.boost; if(!boost) return;",
    "    if (wasApplied) {",
    "      // Toggle off — remove this boost's contributions",
    "      // Remove custom catalogs added by this boost (track by boostId tag)",
    "      state.customCatalogs = state.customCatalogs.filter(function(c){ return c._boostId !== boostId; });",
    "      state.unifiedOrder = state.unifiedOrder.filter(function(o){",
    "        if (o.kind !== 'custom') return true;",
    "        return !!state.customCatalogs.find(function(c){ return c.id === o.id; });",
    "      });",
    "      state.customSeasons = state.customSeasons.filter(function(s){ return s._boostId !== boostId; });",
    "      if (btn) { btn.classList.remove('boost-applied'); btn.innerHTML = 'Apply Boost'; }",
    "      showToast(boost.name+' removed');",
    "      renderUnifiedCatalogList();",
    "      renderCustomSeasonsList();",
    "      // Revert skip button if no boosts remain",
    "      var anyApplied=document.querySelector('.boost-applied');",
    "      var skipBtn=document.getElementById('boost-skip-btn');",
    "      if(skipBtn&&!anyApplied){skipBtn.innerHTML='Skip &rarr;';skipBtn.className='btn btn-ghost';}",
    "      return;",
    "    }",
    "    // Enable requested default catalogs",
    "    if(boost.enableCatalogs) {",
    "      boost.enableCatalogs.forEach(function(id){ state.catalogEnabled[id]=true; });",
    "    }",
    "    // Add custom catalogs (tagged with boostId so they can be removed)",
    "    if(boost.customCatalogs) {",
    "      boost.customCatalogs.forEach(function(cat){",
    "        var newCat=Object.assign({},cat,{id:'boost.'+Date.now()+'.'+Math.random().toString(36).slice(2),enabled:true,_boostId:boostId});",
    "        state.customCatalogs.push(newCat);",
    "        initUnifiedOrder(); state.unifiedOrder.push({kind:'custom',id:newCat.id});",
    "      });",
    "    }",
    "    // Add best-of episode lists (tagged with boostId so they can be removed)",
    "    if(boost.customSeasons) {",
    "      boost.customSeasons.forEach(function(s){",
    "        var listId=uid();",
    "        state.customSeasons.push({",
    "          listId:listId, tmdbId:String(s.tmdbId), tmdbName:s.tmdbName||'', tmdbPoster:null,",
    "          label:s.label||'Best Of', prefix:s.prefix||'✦', posterUrl:null, posterSpec:null, posterMode:'default',",
    "          episodes:s.episodes||[], _boostId:boostId",
    "        });",
    "      });",
    "    }",
    "    boostApplied=true;",
    "    if (btn) { btn.classList.add('boost-applied'); btn.innerHTML = '&#10003; Applied &mdash; click to remove'; }",
    "    showToast(boost.name+' applied \u2013 click again to remove');",
    "    renderCustomSeasonsList();",
    "    renderUnifiedCatalogList();",
    "    // Update skip/continue button",
    "    var skipBtn=document.getElementById('boost-skip-btn');",
    "    if(skipBtn){skipBtn.innerHTML='Continue &rarr;';skipBtn.className='btn btn-primary';}",
    "    // Enrich thumbnails in background",
    "    enrichAllEpisodeThumbnails();",
    "  } catch(e){ showToast('Could not apply boost. Try again.'); }",
    "}",
    "",
    "// ── Share Configuration ──",
    "async function buildShareLink() {",
    "  var title=document.getElementById('share-title-input');",
    "  var desc=document.getElementById('share-desc-input');",
    "  var titleVal=title?title.value.trim():'';",
    "  var descVal=desc?desc.value.trim():'';",
    "  // Share config has no API key — recipient adds their own",
    "  var shareCfg=buildConfigFlat(false);",
    "  shareCfg._shareTitle=titleVal; shareCfg._shareDesc=descVal;",
    "  try {",
    "    var r=await fetch('/api/save-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(shareCfg)});",
    "    var d=await r.json();",
    "    if(!d.id){showToast('Share failed');return;}",
    "    var shareUrl=window.location.origin+'/shared/'+d.id+'/configure';",
    "    var out=document.getElementById('share-url-out'); if(out){out.value=shareUrl;out.style.display='block';}",
    "    var btn=document.getElementById('share-copy-btn'); if(btn){btn.style.display='inline-flex';}",
    "  } catch(e){showToast('Share failed');}",
    "}",
    "function copyShareUrl(){",
    "  var out=document.getElementById('share-url-out'); if(!out) return;",
    "  out.select();",
    "  try{document.execCommand('copy');}catch(e){navigator.clipboard&&navigator.clipboard.writeText(out.value);}",
    "  showToast('Share link copied!');",
    "}",
    "",
    // Init on page load — load existing config first so apiKey is available for hero backgrounds
    "loadExistingConfig();",
    "loadHeroBackgrounds();",
  ].join('\n');

  const editModeBanner = isShared && shareTitle
    ? `<div class="edit-mode-banner" style="flex-direction:column;align-items:flex-start;gap:4px"><div><strong style="font-size:1rem;color:#fff">${shareTitle}</strong></div>${shareDesc ? `<div style="color:var(--text-dim);font-size:0.8rem">${shareDesc}</div>` : ''}<div style="font-size:0.72rem;margin-top:4px;color:var(--gold)">&#128279; Shared configuration &mdash; add your TMDB API key to get started</div></div>`
    : existingConfig && !isShared
    ? `<div class="edit-mode-banner">&#9999;&#65039; <strong>Edit Mode</strong> &mdash; You're editing an existing configuration. Changes will generate a new install URL when you reach the Install page.</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>GoodTaste ${existingConfig ? '— Edit' : '— Configure'}</title>
<style>${css}</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-brand">Good<span>Taste</span></div>
  <div class="topbar-steps">
    <div class="step-pill active" id="step-1"><span class="step-dot"></span><span class="step-label">Connect</span></div>
    <span class="step-divider">&rsaquo;</span>
    <div class="step-pill" id="step-2"><span class="step-dot"></span><span class="step-label">Boost</span></div>
    <span class="step-divider">&rsaquo;</span>
    <div class="step-pill" id="step-3"><span class="step-dot"></span><span class="step-label">Lists</span></div>
    <span class="step-divider">&rsaquo;</span>
    <div class="step-pill" id="step-4"><span class="step-dot"></span><span class="step-label">Catalogs</span></div>
    <span class="step-divider">&rsaquo;</span>
    <div class="step-pill" id="step-5"><span class="step-dot"></span><span class="step-label">Install</span></div>
  </div>
</div>

<div class="main">

  <!-- PAGE 1: Connect -->
  <div class="page active" id="page-1">
    ${editModeBanner}
    <div class="hero-wrap">
      <div class="hero-bg">
        <div class="hero-bg-row" id="hero-bg-row1"></div>
        <div class="hero-bg-row row2" id="hero-bg-row2"></div>
        <div class="hero-bg-overlay"></div>
      </div>
      <div class="hero">
        <div class="hero-logo">Good<span>Taste</span></div>
        <div class="hero-tagline">The ultimate metadata &amp; curation addon</div>
        <div class="hero-features">
          <div class="hero-feat"><strong>Full Metadata &amp; Search</strong>Rich posters, ratings, cast, trailers &mdash; all sourced from TMDB</div>
          <div class="hero-feat"><strong>Curated Episode Lists</strong>Handpick episodes from any series and stream straight from your list</div>
          <div class="hero-feat"><strong>Custom Poster</strong>Give each curated series its own look &mdash; just drop in a URL for any custom poster image</div>
          <div class="hero-feat"><strong>Catalog Manager</strong>Create your own movie and series catalogs &mdash; from TMDB, MDBList, IMDB, or hand-picked titles</div>
          <div class="hero-feat"><strong>Boost Gallery</strong>Start fast with curated preset packs &mdash; the best catalogs and episode lists, ready to go</div>
          <div class="hero-feat"><strong>Season Zero <span class="beta-inline">Beta</span></strong>Auto-adds the top-rated episodes of every series to a Season 0</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-eyebrow">Step 1 of 4</div>
      <div class="card-title">Connect to TMDB</div>
      <div class="card-sub">Enter your free TMDB API key to get started. GoodTaste uses TMDB to fetch metadata, search shows, and resolve episodes.</div>
      <div class="field">
        <label>TMDB API Key</label>
        <input type="password" id="apiKey" placeholder="Paste your key here..." autocomplete="off" spellcheck="false" onkeydown="if(event.key==='Enter') validateApiKey()"/>
        <p class="hint">Free key at <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a> &rarr; API &rarr; API Key</p>
      </div>
      <button class="btn btn-primary btn-lg" style="width:100%" onclick="validateApiKey()" id="btn-validate">Continue &rarr;</button>
    </div>
  </div>

  <!-- PAGE 2: Boost Gallery -->
  <div class="page" id="page-2">
    <div class="card">
      <div class="card-eyebrow">Step 2 of 5</div>
      <div class="card-title">Boost Gallery</div>
      <div class="card-sub">Get started fast with a curated preset &mdash; hand-picked catalogs and best-of episode lists from the world&rsquo;s best film and television. Everything is editable after applying.</div>
      <div id="boost-gallery-cards" style="margin-bottom:1rem"></div>
    </div>
    <div class="nav-row">
      <button class="btn btn-ghost" onclick="goTo(1)">&larr; Back</button>
      <button class="btn btn-ghost" onclick="boostApplied=true;goTo(3)" id="boost-skip-btn">Skip &rarr;</button>
    </div>
  </div>

  <!-- PAGE 3: Curated Lists -->
  <div class="page" id="page-3">
    <div class="card">
      <div class="card-eyebrow">Step 3 of 5</div>
      <div class="card-title">Curated Episode Lists</div>
      <div class="card-sub">Search for a TV show and build a curated episode list. Each list appears as its own entry in Stremio with a custom name. Click &#9998; next to any list to set a custom poster via URL.</div>
      <div class="field search-wrap">
        <span class="search-icon">&#128269;</span>
        <input type="text" id="series-search" placeholder="Search for a TV show..." oninput="debounceSearch(this.value)" autocomplete="off"/>
      </div>
      <div id="search-results" class="search-results"></div>
    </div>
    <div class="card">
      <div class="section-header"><span class="section-label">Your Lists</span></div>
      <div id="custom-seasons-list"><div class="empty-state">No shows yet. Search above to get started.</div></div>
    </div>
    <div class="szero-card" id="szero-card">
      <div class="szero-header" onclick="toggleSzeroExpand()">
        <div class="szero-header-left"><div><div class="szero-title-row"><span class="szero-title-text">Season Zero</span><span class="beta-badge">Beta</span></div><div class="szero-desc">Auto-adds top-rated episodes of every series to a Season 0.</div></div></div>
        <span class="szero-expand-icon">&#9660;</span>
      </div>
      <div class="szero-body">
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
          <div class="field" style="margin-bottom:0;flex:1;min-width:160px"><label>Top N Episodes</label><input type="number" id="topN" placeholder="20" min="5" max="100" value="20"/></div>
          <div class="catalog-row" style="flex:1;min-width:200px;margin-bottom:0"><div class="catalog-row-info"><div style="font-size:0.87rem;font-weight:600;color:var(--text)">Enable Season Zero</div><div class="catalog-row-type">Off by default</div></div><label class="toggle"><input type="checkbox" id="showAutoSeason"/><span class="toggle-slider"></span></label></div>
        </div>
        <div class="szero-warning"><strong>Note:</strong> Streaming from Season Zero may not work on all platforms.</div>
      </div>
    </div>
    <div class="nav-row">
      <button class="btn btn-ghost" onclick="goTo(2)">&larr; Back</button>
      <button class="btn btn-primary btn-lg" onclick="goTo(4)">Catalogs &rarr;</button>
    </div>
  </div>

  <!-- PAGE 4: Catalogs -->
  <div class="page" id="page-4">
    <div class="card">
      <div class="card-eyebrow">Step 4 of 5</div>
      <div class="card-title">Catalog Manager</div>
      <div class="card-sub">Drag &#8801; to reorder. Tap a name to rename. Toggle to enable/disable. Mix TMDB catalogs with your curated Best Of lists in the same catalog.</div>
      <div id="all-catalogs-list" style="margin-bottom:1rem"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">
        <div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-mute)">Add Custom Catalog</div>
        <button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()" id="btn-add-cat">+ Add</button>
      </div>
      <div class="custom-catalog-form" id="custom-catalog-form">
        <div id="cc-step-name" class="cc-step active">
          <div style="font-size:0.8rem;font-weight:600;color:var(--text-dim);margin-bottom:10px">New Catalog &mdash; Name &amp; Type</div>
          <div class="form-row">
            <div class="field" style="margin-bottom:0"><label>Catalog Name</label><input type="text" id="cc-new-name" placeholder="e.g. Sci-Fi Classics" onkeydown="if(event.key==='Enter') ccGoStep2()"/></div>
            <div class="field" style="margin-bottom:0"><label>Type</label><select id="cc-new-type"><option value="movie">Movie</option><option value="series">Series</option></select></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-primary btn-sm" onclick="ccGoStep2()">Next &rarr;</button>
            <button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()">Cancel</button>
          </div>
        </div>
        <div id="cc-step-source" class="cc-step">
          <div style="font-size:0.8rem;font-weight:600;color:var(--text-dim);margin-bottom:2px">Choose Source</div>
          <div style="font-size:0.75rem;color:var(--text-mute);margin-bottom:12px">Catalog: <span id="cc-step2-name-display" style="color:var(--gold)"></span> &nbsp;&middot;&nbsp; <button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:0.7rem" onclick="ccBackStep1()">&larr; Edit</button></div>
          <div class="add-cat-tabs">
            <button class="add-cat-tab active" id="add-cat-tab-items" onclick="switchAddCatTab('items')">Pick Items</button>
            <button class="add-cat-tab" id="add-cat-tab-tmdb-builder" onclick="switchAddCatTab('tmdb-builder')">TMDB Discover</button>
            <button class="add-cat-tab" id="add-cat-tab-mdblist" onclick="switchAddCatTab('mdblist')">MDBList</button>
            <button class="add-cat-tab" id="add-cat-tab-imdb" onclick="switchAddCatTab('imdb')">IMDB</button>
          </div>
          <div class="add-cat-panel active" id="add-cat-panel-items">
            <div style="font-size:0.73rem;color:var(--text-mute);margin-bottom:8px">Search TMDB to hand-pick specific movies or shows, or include your curated Best Of lists below.</div>
            <input type="text" id="cc-items-search" placeholder="Search for a movie or show..." oninput="debounceItemsSearch(this.value)" autocomplete="off"/>
            <div id="cc-items-results" style="margin-top:6px;max-height:220px;overflow-y:auto"></div>
            <div id="cc-items-picked" style="margin-top:10px"></div>
            <div id="cc-bestof-inline" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
              <div style="font-size:0.72rem;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-mute);margin-bottom:8px">Include Curated Lists</div>
              <div class="bestof-pick-list" style="max-height:200px;overflow-y:auto"></div>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn btn-primary btn-sm" onclick="addItemsCatalog()">Create Catalog</button>
              <button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()">Cancel</button>
            </div>
          </div>
          <div class="add-cat-panel" id="add-cat-panel-tmdb-builder">
            <div style="font-size:0.73rem;color:var(--text-mute);margin-bottom:10px">Build a dynamic catalog from TMDB Discover.</div>
            <div class="form-row">
              <div class="field" style="margin-bottom:0"><label>Genre</label><select id="cc-genre"><option value="">Any Genre</option></select></div>
              <div class="field" style="margin-bottom:0"><label>Sort By</label><select id="cc-sort">
                <option value="popularity.desc">Most Popular</option>
                <option value="vote_average.desc">Highest Rated</option>
                <option value="release_date.desc">Newest First</option>
                <option value="release_date.asc">Oldest First</option>
                <option value="revenue.desc">Highest Revenue</option>
                <option value="primary_release_date.desc">Release Date ↓</option>
                <option value="original_title.asc">Title A–Z</option>
                <option value="vote_count.desc">Most Voted</option>
              </select></div>
              <div class="field" style="margin-bottom:0"><label>Language</label><select id="cc-language">
                <option value="">Any</option>
                <option value="en">English</option>
                <option value="ko">Korean</option>
                <option value="ja">Japanese</option>
                <option value="fr">French</option>
                <option value="es">Spanish</option>
                <option value="de">German</option>
                <option value="it">Italian</option>
                <option value="pt">Portuguese</option>
                <option value="zh">Chinese</option>
                <option value="hi">Hindi</option>
                <option value="ar">Arabic</option>
                <option value="ru">Russian</option>
                <option value="tr">Turkish</option>
                <option value="th">Thai</option>
              </select></div>
            </div>
            <div style="margin-top:8px">
              <button class="btn btn-ghost btn-sm" style="font-size:0.7rem;padding:3px 10px" onclick="toggleAdvancedCatOptions(this)">&#9881; Advanced options</button>
            </div>
            <div id="cc-advanced" style="display:none">
              <div class="form-row" style="margin-top:10px">
                <div class="field" style="margin-bottom:0"><label>Min Year</label><input type="number" id="cc-min-year" placeholder="e.g. 2010" style="width:90px"/></div>
                <div class="field" style="margin-bottom:0"><label>Max Year</label><input type="number" id="cc-max-year" placeholder="e.g. 2024" style="width:90px"/></div>
                <div class="field" style="margin-bottom:0"><label>Min Rating</label><input type="number" id="cc-min-rating" placeholder="e.g. 7.5" step="0.1" min="0" max="10" style="width:80px"/></div>
                <div class="field" style="margin-bottom:0"><label>Min Votes</label><input type="number" id="cc-min-votes" placeholder="e.g. 100" style="width:90px"/></div>
              </div>
              <div class="form-row" style="margin-top:10px">
                <div class="field" style="margin-bottom:0"><label>Network <span style="font-size:0.65rem;color:var(--text-mute)">(TV only)</span></label><select id="cc-network">
                  <option value="">Any Network</option>
                  <option value="213">Netflix</option>
                  <option value="1024">Amazon Prime</option>
                  <option value="2739">Disney+</option>
                  <option value="49">HBO</option>
                  <option value="2552">Apple TV+</option>
                  <option value="453">Hulu</option>
                  <option value="67">Showtime</option>
                  <option value="16">NBC</option>
                  <option value="2">ABC</option>
                  <option value="4">CBS</option>
                  <option value="6">Fox</option>
                  <option value="56">AMC</option>
                  <option value="174">AMC</option>
                  <option value="19">FX</option>
                  <option value="77">Starz</option>
                  <option value="318">Peacock</option>
                  <option value="3353">Paramount+</option>
                  <option value="4330">Max</option>
                  <option value="64">BBC One</option>
                  <option value="332">BBC Two</option>
                  <option value="4">Channel 4</option>
                  <option value="2333">Sky</option>
                </select></div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
                <label style="display:flex;align-items:center;gap:6px;font-size:0.75rem;color:var(--text-mute);cursor:pointer"><input type="checkbox" id="cc-adult"/> Include Adult</label>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn btn-primary btn-sm" onclick="addCustomCatalog()">Add Catalog</button>
              <button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()">Cancel</button>
            </div>
          </div>
          <div class="add-cat-panel" id="add-cat-panel-mdblist">
            <div style="font-size:0.73rem;color:rgba(240,192,64,0.7);background:rgba(240,192,64,0.06);border:1px solid rgba(240,192,64,0.15);border-radius:8px;padding:8px 10px;margin-bottom:10px">&#9888; MDBList import is experimental. List must be Public.</div>
            <div style="display:flex;gap:8px;margin-bottom:8px"><input type="text" id="mdb-cat-url" placeholder="https://mdblist.com/lists/username/listname" style="flex:1;font-size:0.85rem"/><button class="btn btn-ghost btn-sm" id="mdb-cat-btn" onclick="previewMdbCatalog()" style="white-space:nowrap">Import</button></div>
            <div id="mdb-cat-status" style="font-size:0.73rem;color:var(--text-mute);min-height:18px;margin-bottom:8px"></div>
            <div id="mdb-cat-preview" style="display:none">
              <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:flex-end"><div class="field" style="margin-bottom:0;min-width:120px"><label>Type</label><select id="mdb-cat-type"><option value="movie">Movie</option><option value="series">Series</option></select></div><button class="btn btn-primary btn-sm" onclick="addMdbCatalog()">Add</button></div>
              <div id="mdb-cat-thumbs" style="display:flex;gap:6px;overflow:hidden;opacity:0.7"></div>
            </div>
            <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()">Cancel</button></div>
          </div>
          <div class="add-cat-panel" id="add-cat-panel-imdb">
            <div style="font-size:0.73rem;color:rgba(240,192,64,0.7);background:rgba(240,192,64,0.06);border:1px solid rgba(240,192,64,0.15);border-radius:8px;padding:8px 10px;margin-bottom:10px">&#9888; IMDB import is experimental.</div>
            <div style="display:flex;gap:8px;margin-bottom:4px"><input type="text" id="imdb-cat-url" placeholder="https://www.imdb.com/list/ls086682535/ or /chart/top/" style="flex:1;font-size:0.85rem"/><button class="btn btn-ghost btn-sm" id="imdb-cat-btn" onclick="previewImdbCatalog()" style="white-space:nowrap">Import</button></div>
            <div style="font-size:0.68rem;color:var(--text-mute);margin-bottom:8px">Charts: /chart/top/ &middot; /chart/moviemeter/ &middot; /chart/toptv/ &middot; /chart/boxoffice/</div>
            <div id="imdb-cat-status" style="font-size:0.73rem;color:var(--text-mute);min-height:18px;margin-bottom:8px"></div>
            <div id="imdb-cat-preview" style="display:none">
              <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:flex-end"><div class="field" style="margin-bottom:0;min-width:120px"><label>Type</label><select id="imdb-cat-type"><option value="movie">Movie</option><option value="series">Series</option></select></div><button class="btn btn-primary btn-sm" onclick="addImdbCatalog()">Add</button></div>
              <div id="imdb-cat-thumbs" style="display:flex;gap:6px;overflow:hidden;opacity:0.7"></div>
            </div>
            <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()">Cancel</button></div>
          </div>
        </div>
      </div>
    </div>
    <div class="nav-row">
      <button class="btn btn-ghost" onclick="goTo(3)">&larr; Back</button>
      <button class="btn btn-primary btn-lg" onclick="goTo(5)">Generate Install Link &rarr;</button>
    </div>
  </div>

  <!-- PAGE 5: Install -->
  <div class="page" id="page-5">
    <div class="card">
      <div class="install-hero">
        <div class="install-hero-title">You have <span>good taste.</span></div>
        <div class="install-hero-sub">Add GoodTaste directly to Stremio or copy the manifest URL</div>
      </div>
      <div id="ep-parade" class="ep-parade" style="display:none"></div>
      <div id="install-summary"></div>
      <button class="btn-install" onclick="openStremio()">Open in Stremio</button>
      <div class="or-divider">&mdash; or copy the manifest URL &mdash;</div>
      <div class="copy-row">
        <input type="text" id="manifest-url" readonly/>
        <button class="btn-copy" id="copy-btn" onclick="copyUrl('manifest-url','copy-btn')">Copy</button>
      </div>
      <div style="margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid var(--border)">
        <div style="font-size:0.72rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-mute);margin-bottom:8px">Edit URL &mdash; bookmark to edit your config later</div>
        <div class="copy-row">
          <input type="text" id="edit-url" readonly style="font-size:0.68rem;color:var(--text-mute)"/>
          <button class="btn-copy" id="copy-edit-btn" onclick="copyUrl('edit-url','copy-edit-btn')">Copy</button>
        </div>
      </div>
      <div style="margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid var(--border)">
        <div style="font-size:0.72rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-mute);margin-bottom:12px">Share Your Configuration</div>
        <div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:12px;line-height:1.5">Share your setup with others &mdash; your API key is never included. The recipient adds their own key when they open the link.</div>
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
          <input type="text" id="share-title-input" placeholder="Give your list a name (optional)" style="flex:1;min-width:160px;font-size:0.82rem"/>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input type="text" id="share-desc-input" placeholder="Short description (optional)" style="flex:1;font-size:0.82rem"/>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-ghost btn-sm" onclick="buildShareLink()">&#128279; Generate Share Link</button>
          <button class="btn btn-ghost btn-sm" id="share-copy-btn" onclick="copyShareUrl()" style="display:none">Copy Link</button>
        </div>
        <input type="text" id="share-url-out" readonly style="display:none;margin-top:10px;font-size:0.7rem;color:var(--text-mute);font-family:DM Mono,monospace"/>
      </div>
    </div>
    <div class="nav-row">
      <button class="btn btn-ghost" onclick="goTo(4)">&larr; Back</button>
    </div>
  </div>

</div>

<div class="modal-backdrop" id="modal-backdrop" onclick="closeModalOnBackdrop(event)">
  <div class="modal">
    <div class="modal-header">
      <img class="modal-poster" id="modal-poster" src="" alt=""/>
      <div><div class="modal-title" id="modal-show-name">Loading...</div><div class="modal-sub" id="modal-show-sub"></div></div>
      <div class="modal-close" onclick="closeModal()">&#10005;</div>
    </div>
    <div class="modal-filter" id="modal-season-filters"></div>
    <div class="modal-ep-list" id="modal-ep-list"><div class="loading-state"><div class="spinner-light"></div> Loading episodes...</div></div>
    <div class="modal-footer">
      <span class="modal-sel-label">Selected: <span id="modal-sel-count">0</span></span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="addSelectedEpisodes()">Save Selection</button>
      </div>
    </div>
  </div>
</div>

<script>
${clientJS}
</script>
</body>
</html>`;
}

const PORT = process.env.PORT || 7000;

// Check for optional canvas module at startup
try {
  require('canvas');
  console.log('[GoodTaste] canvas module found — Banner/Logo poster styles will work.');
} catch(e) {
  console.warn('[GoodTaste] WARNING: canvas module not installed.');
  console.warn('[GoodTaste] Banner and Logo poster styles require canvas. Install with: npm install canvas');
  console.warn('[GoodTaste] Without canvas, those poster styles will fall back to the default TMDB poster.');
}

app.listen(PORT, function() {
  console.log('GoodTaste addon running on port ' + PORT);
  console.log('Configure: http://localhost:' + PORT + '/configure');
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    console.log('[GoodTaste] Upstash Redis configured — configs will persist across restarts.');
  } else {
    console.log('[GoodTaste] No Upstash credentials found — configs stored in: ' + CONFIGS_DIR);
    console.log('[GoodTaste] Set UPSTASH_REDIS_URL + UPSTASH_REDIS_TOKEN env vars for persistent short URLs.');
  }
});
