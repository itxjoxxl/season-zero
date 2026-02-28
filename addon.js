const express = require('express');
const axios = require('axios');

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

function parseConfig(str) {
  try { return JSON.parse(Buffer.from(str, 'base64').toString('utf8')); }
  catch { return {}; }
}

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
  return tmdb('/movie/' + tmdbId, apiKey, { append_to_response: 'external_ids,release_dates,credits,videos' });
}
async function getSeries(tmdbId, apiKey) {
  return tmdb('/tv/' + tmdbId, apiKey, { append_to_response: 'external_ids,content_ratings,credits' });
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
    genres: (m.genre_ids || []).map(String),
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
    genres: (s.genre_ids || []).map(String),
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

// ── Module-level CSV parser ────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      cur += ch; continue;
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

function normType(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

function buildManifest(config) {
  const cfg = config ? parseConfig(config) : {};

  const enabledDefaults = DEFAULT_CATALOGS.filter(d => {
    const override = cfg.catalogEnabled && cfg.catalogEnabled[d.id];
    if (override === false) return false;
    if (override === true) return true;
    return d.enabled;
  });

  const customCatalogs = (cfg.customCatalogs || []).filter(c => c.enabled !== false);
  const customSeasons  = cfg.customSeasons || [];

  // NOTE: default catalogs do NOT include 'search' extra — only dedicated search catalogs handle search
  const allCatalogs = [
    ...enabledDefaults.map(d => {
      const displayName = cfg.catalogNames && cfg.catalogNames[d.id] ? cfg.catalogNames[d.id] : d.name;
      return {
        id: d.id, type: d.type, name: displayName,
        extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }],
      };
    }),
    ...customCatalogs.map(c => ({
      id: c.id, type: c.type, name: c.name,
      extra: [{ name: 'skip', isRequired: false }],
    })),
    { id: 'tmdb.search_movies',  type: 'movie',  name: 'Search Movies',  extra: [{ name: 'search', isRequired: true }] },
    { id: 'tmdb.search_series',  type: 'series', name: 'Search Series',  extra: [{ name: 'search', isRequired: true }] },
  ];

  if (customSeasons.length > 0) {
    allCatalogs.push({ id: 'tmdb.bestof', type: 'series', name: '\u2728 Curated Lists', extra: [] });
  }

  return {
    id:          'community.goodtaste-tmdb',
    version:     '5.1.0',
    name:        'GoodTaste',
    description: 'Curated episode lists, full TMDB metadata, catalogs, and search.',
    logo:        'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg',
    catalogs:    cfg.tmdbApiKey ? allCatalogs : [],
    resources:   ['catalog', 'meta', 'episodeVideos'],
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
app.get('/configure', (req, res) => res.send(configurePage()));

// ─── FEATURED POSTERS (for landing page background) ────────────────────────────
app.get('/api/featured', async function(req, res) {
  try {
    const [movRes, tvRes] = await Promise.all([
      axios.get('https://v3-cinemeta.strem.io/catalog/movie/top.json', { timeout: 8000 }),
      axios.get('https://v3-cinemeta.strem.io/catalog/series/top.json', { timeout: 8000 }),
    ]);
    const moviePosters = (movRes.data.metas || []).slice(0, 10).map(m => m.background || m.poster).filter(Boolean);
    const tvPosters    = (tvRes.data.metas  || []).slice(0, 10).map(m => m.background || m.poster).filter(Boolean);
    res.json({ posters: [...moviePosters, ...tvPosters] });
  } catch(e) {
    res.json({ posters: [] });
  }
});

// ─── BEST OF CATALOG ─────────────────────────────────────────────────────────
app.get('/:config/catalog/series/tmdb.bestof.json', async function(req, res) {
  const cfg    = parseConfig(req.params.config);
  const apiKey = cfg.tmdbApiKey;
  if (!apiKey) return res.json({ metas: [] });
  const customSeasons = cfg.customSeasons || [];
  if (!customSeasons.length) return res.json({ metas: [] });
  try {
    const seriesCache = {};
    const metas = (await Promise.all(customSeasons.map(async function(list) {
      try {
        if (!seriesCache[list.tmdbId]) seriesCache[list.tmdbId] = await getSeries(list.tmdbId, apiKey);
        const series  = seriesCache[list.tmdbId];
        const prefix  = list.prefix || '\u2728';
        const label   = list.label  || 'Curated';
        const epCount = (list.episodes || []).length;
        return {
          id:          'bestof:' + list.listId,
          type:        'series',
          name:        prefix + ' ' + label + ' \u2014 ' + (series.name || 'Unknown'),
          poster:      series.poster_path   ? TMDB_IMG_MD + series.poster_path   : null,
          background:  series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
          description: label + ': ' + epCount + ' episode' + (epCount !== 1 ? 's' : '') + ' from ' + (series.name || 'Unknown') + '.\n\n' + (series.overview || ''),
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
});

// ─── CATALOG ENDPOINT ────────────────────────────────────────────────────────
app.get('/:config/catalog/:type/:id/:extras?.json', async function(req, res) {
  const cfg    = parseConfig(req.params.config);
  const type   = req.params.type;
  const id     = req.params.id;
  const apiKey = cfg.tmdbApiKey;
  if (!apiKey) return res.status(400).json({ metas: [] });

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
  const search = extrasMap.search ? extrasMap.search.trim() : null;

  try {
    // Dedicated search catalogs
    if (id === 'tmdb.search_movies' || id === 'tmdb.search_series') {
      if (!search) return res.json({ metas: [] });
      const tmdbType = id === 'tmdb.search_movies' ? 'movie' : 'tv';
      const data = await tmdb('/search/' + tmdbType, apiKey, { query: search, page });
      const metas = (data.results || []).map(item =>
        tmdbType === 'movie' ? movieToMeta(item) : seriesToMeta(item)
      ).filter(m => m.poster);
      return res.json({ metas });
    }

    // Non-search catalogs: ignore search queries (prevents bleed-through)
    if (search) return res.json({ metas: [] });

    const defaultDef = DEFAULT_CATALOGS.find(d => d.id === id);
    const customDef  = (cfg.customCatalogs || []).find(c => c.id === id);
    const catDef     = defaultDef || customDef;
    if (!catDef) return res.json({ metas: [] });

    // MDBList-sourced catalogs
    if (catDef.path === '_mdblist_' && catDef.mdblistUrl) {
      const listUrl = String(catDef.mdblistUrl).trim();
      // Build correct JSON URL for MDBList
      let fetchUrl;
      if (listUrl.includes('/json')) {
        fetchUrl = listUrl;
      } else {
        // Remove trailing slash, append /json
        fetchUrl = listUrl.replace(/\/$/, '') + '/json';
      }
      const resp = await axios.get(fetchUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'GoodTaste/1.0' },
        timeout: 15000,
      });
      const raw = Array.isArray(resp.data) ? resp.data : (resp.data && resp.data.items ? resp.data.items : []);
      const pageItems = raw.slice(skip, skip + 20);
      const metas = [];
      for (const item of pageItems) {
        const imdbId     = item.imdb_id || item.imdbid || null;
        const itemTmdbId = item.tmdb_id || item.tmdbid || null;
        const mediatype  = (item.mediatype || item.type || '').toLowerCase();
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

    // IMDB list-sourced catalogs
    if (catDef.path === '_imdb_' && catDef.imdbListUrl) {
      const listIdMatch = String(catDef.imdbListUrl).match(/ls\d+/);
      if (!listIdMatch) return res.json({ metas: [] });
      const listId = listIdMatch[0];
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
      try {
        const csvUrl = 'https://www.imdb.com/list/' + listId + '/export';
        const resp = await axios.get(csvUrl, {
          headers: { 'Accept': 'text/csv,*/*', 'User-Agent': UA },
          timeout: 20000,
          validateStatus: s => s >= 200 && s < 400,
        });
        const rows = parseCsv(String(resp.data || ''));
        if (!rows.length) return res.json({ metas: [] });
        const header   = rows[0].map(h => String(h || '').trim().toLowerCase());
        const constIdx = header.findIndex(h => h === 'const');
        const typeIdx  = header.findIndex(h => h === 'title type');
        if (constIdx === -1) return res.json({ metas: [] });
        const ttIds = [];
        const isMovieCatalog = catDef.type === 'movie';
        for (let i = 1; i < rows.length; i++) {
          const cols = rows[i] || [];
          const ttId = String(cols[constIdx] || '').trim();
          const ttype = typeIdx !== -1 ? normType(cols[typeIdx]) : '';
          const isMovieItem = ttype === 'movie' || ttype === 'movies';
          const isTvItem    = ttype === 'tvseries' || ttype === 'tvminiseries' || ttype === 'tvshow';
          if (!ttId || !ttId.startsWith('tt')) continue;
          if (typeIdx !== -1 && ttype === 'tvepisode') continue;
          if (isMovieCatalog && typeIdx !== -1 && !isMovieItem) continue;
          if (!isMovieCatalog && typeIdx !== -1 && isMovieItem) continue;
          ttIds.push(ttId);
        }
        const pageItems = ttIds.slice(skip, skip + 20);
        const metas = [];
        for (const ttId of pageItems) {
          try {
            const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' });
            const mv = (found.movie_results || [])[0];
            const tv = (found.tv_results || [])[0];
            if (mv && isMovieCatalog) { const m = movieToMeta(mv); if (m.poster) metas.push(m); }
            else if (tv && !isMovieCatalog) { const m = seriesToMeta(tv); if (m.poster) metas.push(m); }
          } catch (e) { /* skip */ }
        }
        return res.json({ metas });
      } catch (e) {
        console.error('[imdb catalog]', e.message);
        return res.json({ metas: [] });
      }
    }

    // Handpicked catalog
    if (catDef.path === '_handpicked_' && catDef.items && catDef.items.length) {
      const pageItems = catDef.items.slice(skip, skip + 20);
      const metas = [];
      for (const item of pageItems) {
        try {
          const d = await tmdb((item.type === 'movie' ? '/movie/' : '/tv/') + item.tmdbId, apiKey);
          const meta = item.type === 'movie' ? movieToMeta(d) : seriesToMeta(d);
          if (meta.poster) metas.push(meta);
        } catch (e) { /* skip */ }
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
});

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

app.get('/api/tmdb-search', async function(req, res) {
  const { q, apiKey } = req.query;
  if (!q || !apiKey) return res.json({ results: [] });
  try {
    const data = await tmdb('/search/multi', apiKey, { query: q });
    const results = (data.results || []).slice(0, 12)
      .filter(s => s.media_type === 'movie' || s.media_type === 'tv')
      .map(s => {
        const isMovie = s.media_type === 'movie';
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

// ─── IMDB LIST EPISODE IMPORT ─────────────────────────────────────────────────
app.get('/api/imdb-list', async function(req, res) {
  let { url: listUrl, apiKey, tmdbId } = req.query;
  if (!listUrl || !apiKey || !tmdbId) return res.status(400).json({ error: 'url, apiKey, and tmdbId required' });
  tmdbId = String(tmdbId).replace(/^tmdb:/, '').trim();

  const listIdMatch = String(listUrl).match(/ls\d+/);
  if (!listIdMatch) return res.status(400).json({ error: 'Could not parse IMDB list ID from URL' });
  const listId = listIdMatch[0];
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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
    const hrefMatches  = [...html.matchAll(/\/title\/(tt\d+)\//g)].map(m => m[1]);
    const urlMatches   = [...html.matchAll(/"url"\s*:\s*"https?:\/\/www\.imdb\.com\/title\/(tt\d+)\//g)].map(m => m[1]);
    return [...new Set([...hrefMatches, ...urlMatches])];
  }

  try {
    let csvText = null;
    try { csvText = await fetchImdbCsvExport(); } catch (e) { csvText = null; }

    let ttIds = [];
    if (csvText) {
      const rows = parseCsv(String(csvText));
      if (!rows.length) return res.json({ episodes: [], errors: [{ reason: 'Empty CSV export' }], skipped: 0 });
      const header   = rows[0].map(h => String(h || '').trim().toLowerCase());
      const constIdx = header.findIndex(h => h === 'const');
      const typeIdx  = header.findIndex(h => h === 'title type');
      if (constIdx === -1) return res.status(400).json({ error: 'Unexpected CSV format — missing Const column' });
      for (let i = 1; i < rows.length; i++) {
        const cols = rows[i] || [];
        const ttId = String(cols[constIdx] || '').trim();
        const ttypeNorm = typeIdx !== -1 ? normType(cols[typeIdx]) : '';
        if (ttId && ttId.startsWith('tt') && (typeIdx === -1 || ttypeNorm === 'tvepisode')) ttIds.push(ttId);
      }
    } else {
      ttIds = await scrapeImdbListTtIds();
    }

    ttIds = [...new Set(ttIds)].filter(Boolean);
    if (!ttIds.length) return res.json({ episodes: [], errors: [{ reason: 'No IMDb title IDs found in list' }], skipped: 0 });

    const results = [], errors = [];
    for (const ttId of ttIds) {
      try {
        const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' });
        const epResults = found.tv_episode_results || [];
        if (epResults.length > 0) {
          const matches = epResults.filter(ep => String(ep.show_id) === String(tmdbId));
          if (matches.length > 0) {
            for (const ep of matches) results.push({ season: ep.season_number, episode: ep.episode_number });
          } else {
            errors.push({ ttId, reason: 'Episode belongs to a different show' });
          }
        } else {
          errors.push({ ttId, reason: 'Not found as TV episode on TMDB' });
        }
      } catch (e) { errors.push({ ttId, reason: e.message }); }
    }

    const seen = new Set();
    const deduped = results.filter(ep => {
      const key = ep.season + ':' + ep.episode;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    res.json({ episodes: deduped, errors, skipped: errors.length, totalIds: ttIds.length, matched: deduped.length, tmdbId });
  } catch (e) {
    console.error('[imdb-list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── IMDB LIST CATALOG IMPORT ─────────────────────────────────────────────────
app.get('/api/imdb-catalog', async function(req, res) {
  let { url: listUrl, apiKey } = req.query;
  if (!listUrl || !apiKey) return res.status(400).json({ error: 'url and apiKey required' });

  const listIdMatch = String(listUrl).match(/ls\d+/);
  if (!listIdMatch) return res.status(400).json({ error: 'Could not parse IMDB list ID' });
  const listId = listIdMatch[0];
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  try {
    const csvUrl = 'https://www.imdb.com/list/' + listId + '/export';
    const resp = await axios.get(csvUrl, {
      headers: { 'Accept': 'text/csv,text/plain,*/*', 'User-Agent': UA },
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 400,
    });
    const ct = String(resp.headers && resp.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) throw new Error('IMDB blocked export — list must be public');

    const rows = parseCsv(String(resp.data || ''));
    if (!rows.length) return res.json({ metas: [], count: 0, name: '' });

    const header   = rows[0].map(h => String(h || '').trim().toLowerCase());
    const constIdx = header.findIndex(h => h === 'const');
    const typeIdx  = header.findIndex(h => h === 'title type');
    const nameIdx  = header.findIndex(h => h === 'list name' || h === 'title');
    if (constIdx === -1) return res.status(400).json({ error: 'Unexpected CSV format' });

    const listName = nameIdx !== -1 && rows[1] ? String(rows[1][nameIdx] || '').trim() : '';
    const ttIds = [];
    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i] || [];
      const ttId = String(cols[constIdx] || '').trim();
      const ttype = typeIdx !== -1 ? normType(cols[typeIdx]) : '';
      if (!ttId || !ttId.startsWith('tt')) continue;
      if (ttype === 'tvepisode') continue; // skip episodes for catalog
      ttIds.push({ ttId, ttype });
    }

    const metas = [];
    for (const { ttId, ttype } of ttIds.slice(0, 50)) {
      try {
        const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' });
        const mv = (found.movie_results || [])[0];
        const tv = (found.tv_results   || [])[0];
        if (mv) metas.push(movieToMeta(mv));
        else if (tv) metas.push(seriesToMeta(tv));
      } catch (e) { /* skip */ }
    }

    const movieCount = metas.filter(m => m.type === 'movie').length;
    res.json({ metas, count: ttIds.length, name: listName, suggestedType: movieCount >= metas.length / 2 ? 'movie' : 'series' });
  } catch (e) {
    console.error('[imdb-catalog]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── MDBLIST CATALOG PREVIEW ──────────────────────────────────────────────────
app.get('/api/mdblist-catalog', async function(req, res) {
  let { url: listUrl, apiKey } = req.query;
  if (!listUrl || !apiKey) return res.status(400).json({ error: 'url and apiKey required' });
  const urlStr = String(listUrl).trim();

  try {
    // Build correct MDBList JSON URL
    let fetchUrl;
    if (urlStr.includes('/json')) {
      fetchUrl = urlStr;
    } else {
      fetchUrl = urlStr.replace(/\/$/, '') + '/json';
    }

    const resp = await axios.get(fetchUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GoodTaste/1.0' },
      timeout: 15000,
    });

    const raw = Array.isArray(resp.data) ? resp.data : (resp.data && resp.data.items ? resp.data.items : []);
    if (!raw.length) return res.json({ metas: [], count: 0, name: '' });

    const listName = (resp.data && resp.data.name) ? resp.data.name : '';
    const metas = [];
    for (const item of raw.slice(0, 50)) {
      const imdbId     = item.imdb_id || item.imdbid || null;
      const itemTmdbId = item.tmdb_id || item.tmdbid || null;
      const mediatype  = (item.mediatype || item.type || '').toLowerCase();
      const isMovie    = mediatype === 'movie' || mediatype === 'movies';
      const isTv       = mediatype === 'show' || mediatype === 'tv' || mediatype === 'series';
      try {
        if (itemTmdbId && (isMovie || isTv)) {
          const path = isMovie ? '/movie/' + itemTmdbId : '/tv/' + itemTmdbId;
          const d = await tmdb(path, apiKey);
          metas.push(isMovie ? movieToMeta(d) : seriesToMeta(d));
        } else if (imdbId) {
          const found = await tmdb('/find/' + imdbId, apiKey, { external_source: 'imdb_id' });
          const mv = (found.movie_results || [])[0];
          const tv = (found.tv_results   || [])[0];
          if (mv) metas.push(movieToMeta(mv));
          else if (tv) metas.push(seriesToMeta(tv));
        }
      } catch (e) { /* skip */ }
    }
    const movieCount = metas.filter(m => m.type === 'movie').length;
    res.json({ metas, count: raw.length, name: listName, suggestedType: movieCount >= metas.length / 2 ? 'movie' : 'series' });
  } catch (e) {
    console.error('[mdblist-catalog]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── META ENDPOINTS ───────────────────────────────────────────────────────────
app.get('/:config/meta/movie/:id.json', async function(req, res) {
  const cfg = parseConfig(req.params.config);
  const id  = req.params.id;
  if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });
  if (!id.startsWith('tmdb:')) return res.json({ meta: null });
  try {
    const movie      = await getMovie(extractId(id), cfg.tmdbApiKey);
    const cert       = getMovieCert(movie);
    const director   = (movie.credits && movie.credits.crew || []).find(c => c.job === 'Director');
    const cast       = (movie.credits && movie.credits.cast || []).slice(0, 8).map(c => c.name);
    const trailerKey = (movie.videos && movie.videos.results || []).find(v => v.type === 'Trailer' && v.site === 'YouTube');
    res.json({ meta: {
      id, type: 'movie', name: movie.title,
      poster:        movie.poster_path   ? TMDB_IMG_MD + movie.poster_path   : null,
      background:    movie.backdrop_path ? TMDB_IMG_LG + movie.backdrop_path : null,
      description:   movie.overview,
      releaseInfo:   movie.release_date ? movie.release_date.substring(0, 4) : '',
      runtime:       movie.runtime ? movie.runtime + ' min' : null,
      genres:        (movie.genres || []).map(g => g.name),
      imdbRating:    movie.vote_average ? movie.vote_average.toFixed(1) : null,
      cast, director: director ? director.name : null, certification: cert || null,
      trailers: trailerKey ? [{ source: 'yt', type: 'Trailer', ytId: trailerKey.key }] : [],
      links: movie.external_ids && movie.external_ids.imdb_id
        ? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' + movie.external_ids.imdb_id }] : [],
    }});
  } catch (e) {
    console.error('[movie meta]', e.message);
    res.status(500).json({ err: e.message });
  }
});

app.get('/:config/meta/series/:id.json', async function(req, res) {
  const cfg = parseConfig(req.params.config);
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
      const prefix      = list.prefix || '\u2728';
      const label       = list.label  || 'Curated';
      return res.json({ meta: {
        id: 'bestof:' + listId, type: 'series',
        name:        prefix + ' ' + label + ' \u2014 ' + series.name,
        poster:      series.poster_path   ? TMDB_IMG_MD + series.poster_path   : null,
        background:  series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
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

  if (!id.startsWith('tmdb:')) return res.json({ meta: null });
  const tmdbId = extractId(id);
  const topN   = parseInt(cfg.topN) || 20;
  try {
    const series = await getSeries(tmdbId, cfg.tmdbApiKey);
    const cert   = getSeriesCert(series);
    const cast   = (series.credits && series.credits.cast || []).slice(0, 8).map(c => c.name);
    const imdbId = series.external_ids && series.external_ids.imdb_id || null;
    const videos = [];

    for (let s = 1; s <= (series.number_of_seasons || 0); s++) {
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
      } catch (e) { /* skip */ }
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
    res.json({ meta: {
      id, type: 'series', name: series.name,
      poster:        series.poster_path   ? TMDB_IMG_MD + series.poster_path   : null,
      background:    series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
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
});

// ─── EPISODE VIDEOS ───────────────────────────────────────────────────────────
app.get('/:config/episodeVideos/series/:id.json', async function(req, res) {
  const cfg    = parseConfig(req.params.config);
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
      id: realId, title: target.name, season: target.season, episode: target.episode,
      thumbnail: target.still, overview: target.overview,
    }]});
  } catch (e) {
    console.error('[episodeVideos]', e.message);
    res.json({ videos: [] });
  }
});

// ─── CONFIGURE PAGE ───────────────────────────────────────────────────────────
function configurePage() {
  const defaultCatalogsJson = JSON.stringify(DEFAULT_CATALOGS);

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #080808; --surface: #0f0f0f; --surface2: #161616;
      --border: #1c1c1c; --border2: #252525; --text: #e8e8e8;
      --text-dim: #888; --text-mute: #444; --gold: #f0c040;
      --gold-dim: rgba(240,192,64,0.15); --gold-border: rgba(240,192,64,0.25);
      --danger: #c0392b; --radius: 12px; --transition: 0.22s cubic-bezier(0.4,0,0.2,1);
    }
    html { scroll-behavior: smooth; }
    body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; font-weight: 400; min-height: 100vh; -webkit-font-smoothing: antialiased; }

    /* ── Topbar ── */
    .topbar { background: rgba(8,8,8,0.92); backdrop-filter: blur(16px); border-bottom: 1px solid var(--border); padding: 0 2rem; height: 60px; display: flex; align-items: center; gap: 1rem; position: sticky; top: 0; z-index: 100; }
    .topbar-brand { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 1.1rem; color: #fff; letter-spacing: -0.01em; }
    .topbar-brand span { color: var(--gold); }
    .topbar-steps { display: flex; align-items: center; gap: 0; margin-left: auto; }
    .step-pill { display: flex; align-items: center; gap: 6px; font-size: 0.72rem; font-weight: 500; color: var(--text-mute); padding: 4px 12px; border-radius: 20px; transition: color var(--transition); letter-spacing: 0.02em; }
    .step-pill.active { color: var(--gold); }
    .step-pill.done   { color: var(--text-dim); }
    .step-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border2); transition: background var(--transition), box-shadow var(--transition); flex-shrink: 0; }
    .step-pill.active .step-dot { background: var(--gold); animation: pulse-step 2s ease-in-out infinite; }
    .step-pill.done .step-dot   { background: var(--text-dim); }
    @keyframes pulse-step {
      0%, 100% { box-shadow: 0 0 0 0 rgba(240,192,64,0.5); }
      50% { box-shadow: 0 0 0 5px rgba(240,192,64,0); }
    }
    .step-divider { color: var(--text-mute); font-size: 0.6rem; opacity: 0.4; }
    @media (max-width: 600px) { .topbar { padding: 0 1rem; } .step-label { display: none; } .step-pill { padding: 4px 8px; } }

    /* ── Main layout ── */
    .main { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
    @media (max-width: 600px) { .main { padding: 2rem 1rem 5rem; } }

    /* ── Pages ── */
    .page { display: none; animation: fadeUp 0.35s cubic-bezier(0.4,0,0.2,1); }
    .page.active { display: block; }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }

    /* ── Cards ── */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 2rem; margin-bottom: 1rem; }
    .card-eyebrow { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--gold); margin-bottom: 0.6rem; }
    .card-title { font-family: 'Playfair Display', serif; font-size: 1.4rem; font-weight: 700; color: #fff; margin-bottom: 0.5rem; letter-spacing: -0.02em; line-height: 1.25; }
    .card-sub { font-size: 0.82rem; color: var(--text-dim); line-height: 1.6; margin-bottom: 1.8rem; }

    /* ── Hero ── */
    .hero-wrap { position: relative; overflow: hidden; border-radius: 18px; margin-bottom: 1rem; background: var(--surface); border: 1px solid var(--border); }
    .hero-bg { position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
    .hero-bg-track { display: flex; gap: 6px; height: 100%; animation: bgscroll 40s linear infinite; will-change: transform; }
    @keyframes bgscroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
    .hero-bg-col { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
    .hero-bg-img { width: 120px; height: 80px; object-fit: cover; border-radius: 4px; flex-shrink: 0; filter: brightness(0.5) saturate(0.7); transition: none; }
    .hero-bg-overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(15,15,15,0.3) 0%, rgba(8,8,8,0.85) 100%); z-index: 1; }
    .hero-content { position: relative; z-index: 2; text-align: center; padding: 3rem 2rem 2.5rem; }
    .hero-logo { font-family: 'Playfair Display', serif; font-size: 3.5rem; font-weight: 700; color: #fff; letter-spacing: -0.03em; margin-bottom: 0.3rem; line-height: 1; }
    .hero-logo span { color: var(--gold); }
    .hero-tagline { font-size: 0.85rem; color: rgba(255,255,255,0.55); margin-bottom: 2.5rem; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 500; }
    .hero-features { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; text-align: left; }
    .hero-feat { background: rgba(15,15,15,0.7); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; padding: 12px 14px; font-size: 0.78rem; color: rgba(255,255,255,0.5); line-height: 1.45; backdrop-filter: blur(8px); }
    .hero-feat strong { display: flex; align-items: center; gap: 6px; color: rgba(255,255,255,0.85); font-size: 0.8rem; margin-bottom: 3px; font-weight: 600; }
    .feat-badge { font-size: 0.55rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; background: rgba(240,192,64,0.15); border: 1px solid rgba(240,192,64,0.3); color: var(--gold); padding: 1px 5px; border-radius: 3px; }
    @media (max-width: 480px) { .hero-features { grid-template-columns: 1fr; } .hero-logo { font-size: 2.8rem; } }

    /* ── Fields ── */
    .field { margin-bottom: 1.25rem; }
    label { display: block; font-size: 0.7rem; font-weight: 600; color: var(--text-dim); margin-bottom: 7px; letter-spacing: 0.08em; text-transform: uppercase; }
    input[type=text], input[type=number], input[type=password], textarea, select { width: 100%; background: var(--bg); border: 1px solid var(--border2); border-radius: var(--radius); padding: 12px 15px; color: var(--text); font-size: 0.9rem; font-family: 'DM Sans', sans-serif; outline: none; transition: border-color var(--transition), box-shadow var(--transition); }
    input:focus, select:focus, textarea:focus { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-dim); }
    textarea { resize: vertical; min-height: 80px; line-height: 1.5; }
    select { cursor: pointer; }
    input.error { border-color: var(--danger) !important; animation: shake 0.3s; }
    @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
    .hint { font-size: 0.72rem; color: var(--text-mute); margin-top: 6px; }
    .hint a { color: var(--gold); text-decoration: none; }

    /* ── Buttons ── */
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 11px 22px; border-radius: var(--radius); font-size: 0.87rem; font-weight: 600; font-family: 'DM Sans', sans-serif; cursor: pointer; border: none; transition: all var(--transition); letter-spacing: 0.01em; }
    .btn-primary { background: var(--gold); color: #000; }
    .btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
    .btn-ghost { background: transparent; border: 1px solid var(--border2); color: var(--text-dim); }
    .btn-ghost:hover { border-color: var(--text-dim); color: var(--text); }
    .btn-danger { background: rgba(192,57,43,0.15); border: 1px solid rgba(192,57,43,0.3); color: #e05252; }
    .btn-danger:hover { background: rgba(192,57,43,0.25); }
    .btn-install { width: 100%; background: var(--gold); color: #000; font-size: 1rem; font-weight: 700; padding: 16px; border-radius: 14px; }
    .btn-install:hover { opacity: 0.9; transform: translateY(-2px); box-shadow: 0 8px 32px rgba(240,192,64,0.25); }
    .btn-sm { padding: 7px 14px; font-size: 0.78rem; }
    .btn-lg { padding: 13px 28px; font-size: 0.95rem; }

    /* ── Toggle ── */
    .toggle { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; inset: 0; background: var(--border2); border-radius: 22px; transition: background 0.2s; cursor: pointer; }
    .toggle-slider::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform 0.2s; }
    .toggle input:checked + .toggle-slider { background: var(--gold); }
    .toggle input:checked + .toggle-slider::before { transform: translateX(18px); }

    /* ── Section headers ── */
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .section-label { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-mute); }

    /* ── Search ── */
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

    /* ── Show cards ── */
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

    /* ── Add tabs ── */
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

    /* ── Episode list ── */
    .ep-list { list-style: none; }
    .ep-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; margin-bottom: 5px; background: var(--bg); border: 1px solid var(--border); cursor: grab; user-select: none; transition: border-color var(--transition), opacity var(--transition); touch-action: none; }
    .ep-item.dragging  { opacity: 0.4; cursor: grabbing; }
    .ep-item.drag-over { border-color: var(--gold); background: var(--gold-dim); }
    .ep-rank { width: 22px; text-align: center; flex-shrink: 0; font-size: 0.68rem; color: var(--text-mute); font-family: 'DM Mono', monospace; }
    .ep-drag { color: var(--text-mute); flex-shrink: 0; font-size: 0.85rem; cursor: grab; padding: 4px 2px; touch-action: none; }
    .ep-thumb { width: 56px; height: 32px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: var(--surface2); }
    .ep-info  { flex: 1; min-width: 0; }
    .ep-label { font-size: 0.79rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ep-sublabel { font-size: 0.67rem; color: var(--text-mute); margin-top: 2px; }
    .ep-rating { font-size: 0.7rem; color: var(--gold); font-family: 'DM Mono', monospace; flex-shrink: 0; }
    .ep-del { flex-shrink: 0; color: var(--text-mute); cursor: pointer; font-size: 0.9rem; padding: 4px 5px; border-radius: 5px; transition: color var(--transition); }
    .ep-del:hover { color: #e05252; }
    .ep-list-empty { font-size: 0.8rem; color: var(--text-mute); padding: 10px 0; }

    /* ── Catalog rows ── */
    .catalog-row { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 8px; }
    .catalog-row-info { flex: 1; min-width: 0; }
    .catalog-row-name-input { background: transparent; border: none; border-bottom: 1px solid transparent; border-radius: 0; padding: 2px 0; font-size: 0.87rem; font-weight: 600; color: var(--text); width: 100%; font-family: 'DM Sans', sans-serif; transition: border-color var(--transition); }
    .catalog-row-name-input:focus { outline: none; border-bottom-color: var(--gold); box-shadow: none; }
    .catalog-row-type { font-size: 0.7rem; color: var(--text-mute); margin-top: 2px; }
    .catalog-section-label { font-size: 0.68rem; font-weight: 600; color: var(--text-mute); text-transform: uppercase; letter-spacing: 0.1em; margin: 16px 0 8px; }
    .catalog-section-header { display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 8px 0 8px; border-bottom: 1px solid var(--border); margin-bottom: 10px; }
    .catalog-section-header:hover .catalog-section-label { color: var(--text-dim); }
    .catalog-collapse-body { overflow: hidden; transition: max-height 0.3s ease; }
    .catalog-collapse-body.collapsed { max-height: 0; }
    .catalog-chevron { color: var(--text-mute); font-size: 0.7rem; transition: transform 0.2s; }
    .catalog-section-header.collapsed .catalog-chevron { transform: rotate(-90deg); }
    .custom-catalog-form { background: var(--surface2); border: 1px solid var(--border2); border-radius: 14px; padding: 16px; margin-top: 12px; display: none; }
    .custom-catalog-form.open { display: block; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    @media (max-width: 480px) { .form-row { grid-template-columns: 1fr; } }
    .custom-catalog-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 8px; }
    .custom-catalog-item-info { flex: 1; }
    .custom-catalog-item-name { font-size: 0.86rem; font-weight: 600; color: var(--text); }
    .custom-catalog-item-sub  { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; font-family: 'DM Mono', monospace; }

    /* ── Handpicked catalog ── */
    .handpicked-search-results { max-height: 240px; overflow-y: auto; margin-top: 8px; }
    .handpicked-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; transition: background var(--transition); }
    .handpicked-item:hover { background: var(--surface2); }
    .handpicked-item img { width: 30px; height: 44px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: var(--surface2); }
    .handpicked-item-info { flex: 1; min-width: 0; }
    .handpicked-item-name { font-size: 0.83rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .handpicked-item-meta { font-size: 0.7rem; color: var(--text-mute); margin-top: 1px; }
    .handpicked-added { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; min-height: 28px; }
    .handpicked-tag { display: inline-flex; align-items: center; gap: 5px; background: var(--gold-dim); border: 1px solid var(--gold-border); color: var(--gold); font-size: 0.7rem; font-weight: 600; padding: 3px 8px 3px 10px; border-radius: 20px; }
    .handpicked-tag button { background: none; border: none; color: var(--gold); cursor: pointer; padding: 0; font-size: 0.8rem; line-height: 1; }

    /* ── Season Zero card (compact) ── */
    .szero-card { background: rgba(240,192,64,0.04); border: 1px solid rgba(240,192,64,0.15); border-radius: 14px; padding: 14px 18px; margin-bottom: 1rem; }
    .szero-header { display: flex; align-items: center; gap: 10px; justify-content: space-between; cursor: pointer; }
    .szero-header-left { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .szero-title-row { display: flex; align-items: center; gap: 7px; }
    .szero-title { font-size: 0.87rem; font-weight: 600; color: var(--text); }
    .beta-badge { display: inline-flex; align-items: center; background: rgba(240,192,64,0.1); border: 1px solid rgba(240,192,64,0.3); color: var(--gold); font-size: 0.55rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 5px; border-radius: 4px; }
    .szero-short-desc { font-size: 0.76rem; color: var(--text-mute); margin-top: 2px; }
    .szero-expand { font-size: 0.72rem; color: var(--text-mute); cursor: pointer; white-space: nowrap; display: flex; align-items: center; gap: 4px; flex-shrink: 0; transition: color var(--transition); }
    .szero-expand:hover { color: var(--gold); }
    .szero-body { margin-top: 14px; display: none; border-top: 1px solid rgba(240,192,64,0.1); padding-top: 14px; }
    .szero-card.expanded .szero-body { display: block; }
    .szero-full-desc { font-size: 0.78rem; color: var(--text-mute); line-height: 1.6; margin-bottom: 14px; }

    /* ── Modal ── */
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

    /* ── Install page ── */
    .install-hero { text-align: center; padding: 1rem 0 2rem; }
    .install-hero-title { font-family: 'Playfair Display', serif; font-size: 2rem; font-weight: 700; color: #fff; margin-bottom: 6px; letter-spacing: -0.02em; }
    .install-hero-title span { color: var(--gold); }
    .install-hero-sub { font-size: 0.83rem; color: var(--text-dim); }
    .summary-row { display: flex; align-items: center; justify-content: space-between; padding: 11px 14px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 8px; font-size: 0.82rem; }
    .summary-label { color: var(--text-dim); }
    .summary-value { color: #fff; font-weight: 600; font-family: 'DM Mono', monospace; font-size: 0.78rem; }
    .summary-value.accent { color: var(--gold); }
    .ep-parade { display: flex; gap: 6px; overflow: hidden; margin: 1.5rem 0; mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent); -webkit-mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent); }
    .ep-parade-track { display: flex; gap: 6px; animation: scroll 20s linear infinite; flex-shrink: 0; }
    @keyframes scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
    .parade-thumb { width: 80px; height: 45px; border-radius: 6px; object-fit: cover; flex-shrink: 0; opacity: 0.7; }
    .or-divider { text-align: center; font-size: 0.72rem; color: var(--text-mute); margin: 14px 0 12px; }
    .copy-row { display: flex; gap: 8px; }
    .copy-row input { flex: 1; font-size: 0.72rem; color: var(--text-mute); padding: 10px 12px; font-family: 'DM Mono', monospace; }
    .btn-copy { flex-shrink: 0; padding: 10px 18px; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius); color: var(--text-dim); font-size: 0.78rem; font-weight: 600; cursor: pointer; transition: all var(--transition); font-family: 'DM Sans', sans-serif; }
    .btn-copy:hover  { border-color: var(--gold); color: var(--gold); }
    .btn-copy.copied { border-color: #4caf82; color: #4caf82; }

    /* ── Utilities ── */
    .nav-row { display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; }
    .spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(0,0,0,0.2); border-top-color: rgba(0,0,0,0.7); border-radius: 50%; animation: spin 0.7s linear infinite; }
    .spinner-light { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,0.2); border-top-color: rgba(255,255,255,0.8); border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-state { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 2rem; font-size: 0.82rem; color: var(--text-mute); }
    .empty-state { text-align: center; padding: 2.5rem 1rem; color: var(--text-mute); font-size: 0.82rem; }
    .flex-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .mt-1 { margin-top: 8px; } .mt-2 { margin-top: 14px; }
  `;

  const clientJS = [
    "var DEFAULT_CATALOGS = " + defaultCatalogsJson + ";",
    "var state = { apiKey:'', topN:20, showAutoSeason:false, customSeasons:[], catalogEnabled:{}, catalogNames:{}, customCatalogs:[] };",
    "var modalData = { listId:null, tmdbId:null, allEpisodes:[], filteredSeason:'all', selected:new Set() };",
    "var genreCache = { movie:null, tv:null };",
    "var handpickedItems = [];",
    "var TOTAL_PAGES = 4;",
    "",
    "function uid() { return Math.random().toString(36).slice(2)+Date.now().toString(36); }",
    "",
    "function goTo(n) {",
    "  document.querySelectorAll('.page').forEach(function(p,i){ p.classList.toggle('active',i+1===n); });",
    "  document.querySelectorAll('[id^=step-]').forEach(function(el) {",
    "    var num=parseInt(el.id.replace('step-',''));",
    "    el.classList.remove('active','done');",
    "    if(num===n) el.classList.add('active');",
    "    else if(num<n) el.classList.add('done');",
    "  });",
    "  if(n===TOTAL_PAGES) buildInstallPage();",
    "  window.scrollTo({top:0,behavior:'smooth'});",
    "}",
    "",
    // ── API key validation ──
    "async function validateApiKey() {",
    "  var input=document.getElementById('apiKey');",
    "  var key=input.value.trim();",
    "  var btn=document.getElementById('btn-validate');",
    "  if(!key){ flashError(input); return; }",
    "  btn.innerHTML='<span class=\"spinner\"></span> Checking...'; btn.disabled=true;",
    "  try {",
    "    var r=await fetch('/api/search?q=test&apiKey='+encodeURIComponent(key));",
    "    var d=await r.json();",
    "    if(d.error) throw new Error(d.error);",
    "    state.apiKey=key;",
    "    renderDefaultCatalogs();",
    "    goTo(2);",
    "  } catch(e) {",
    "    flashError(input); input.placeholder='Invalid key — try again';",
    "  } finally { btn.innerHTML='Continue &rarr;'; btn.disabled=false; }",
    "}",
    "function flashError(el){ el.classList.add('error'); el.focus(); setTimeout(function(){ el.classList.remove('error'); },2000); }",
    "",
    // ── Tab switching ──
    "function switchAddTab(listId,tab) {",
    "  ['picker','imdb','paste'].forEach(function(t){",
    "    var btn=document.getElementById('add-tab-'+t+'-'+listId);",
    "    var panel=document.getElementById('add-panel-'+t+'-'+listId);",
    "    if(btn) btn.classList.toggle('active',t===tab);",
    "    if(panel) panel.classList.toggle('active',t===tab);",
    "  });",
    "}",
    "",
    // ── Paste episodes ──
    "function parsePasteEpisodes(text) {",
    "  var results=[];",
    "  var re=/[Ss](\\d{1,3})[Ee](\\d{1,3})|(?:^|\\D)(\\d{1,2})[Xx](\\d{1,3})(?:\\D|$)/gm; var m;",
    "  while((m=re.exec(text))!==null){",
    "    var s=parseInt(m[1]||m[3]); var e=parseInt(m[2]||m[4]);",
    "    if(!isNaN(s)&&!isNaN(e)&&s>0&&e>0) results.push({season:s,episode:e});",
    "  }",
    "  var seen=new Set();",
    "  return results.filter(function(ep){ var k=ep.season+':'+ep.episode; if(seen.has(k)) return false; seen.add(k); return true; });",
    "}",
    "function applyPaste(listId) {",
    "  var ta=document.getElementById('paste-input-'+listId);",
    "  var st=document.getElementById('paste-status-'+listId);",
    "  if(!ta||!st) return;",
    "  var text=ta.value.trim();",
    "  if(!text){ st.textContent='Paste some episode codes first'; st.className='paste-status err'; return; }",
    "  var parsed=parsePasteEpisodes(text);",
    "  if(!parsed.length){ st.textContent='No codes found. Use S01E01 or 1x01 format.'; st.className='paste-status err'; return; }",
    "  var list=getList(listId); if(!list) return;",
    "  var allEps=(modalData.tmdbId===list.tmdbId)?modalData.allEpisodes:[];",
    "  var existingKeys=new Set(list.episodes.map(function(e){ return e.season+':'+e.episode; }));",
    "  var added=0;",
    "  for(var i=0;i<parsed.length;i++){",
    "    var ref=parsed[i]; var key=ref.season+':'+ref.episode;",
    "    if(!existingKeys.has(key)){ existingKeys.add(key); var full=allEps.find(function(e){ return e.season===ref.season&&e.episode===ref.episode; }); list.episodes.push(full||ref); added++; }",
    "  }",
    "  st.textContent='Added '+added+' of '+parsed.length+' episode'+(parsed.length!==1?'s':'')+' (dupes skipped)'; st.className='paste-status ok';",
    "  ta.value=''; renderListEpisodes(listId); updateEpCount(listId);",
    "}",
    "",
    // ── Default catalog UI ──
    "function renderDefaultCatalogs() {",
    "  ['movie','series'].forEach(function(type){",
    "    var el=document.getElementById('catalog-defaults-'+type);",
    "    var cats=DEFAULT_CATALOGS.filter(function(c){ return c.type===type; });",
    "    el.innerHTML=cats.map(function(c){",
    "      var checked=state.catalogEnabled[c.id]!==undefined?state.catalogEnabled[c.id]:c.enabled;",
    "      var displayName=state.catalogNames[c.id]||c.name;",
    "      return '<div class=\"catalog-row\">'+",
    "        '<div class=\"catalog-row-info\">'+",
    "          '<input class=\"catalog-row-name-input\" type=\"text\" value=\"'+esc(displayName)+'\" placeholder=\"'+esc(c.name)+'\" oninput=\"setCatalogName(\\''+ c.id +'\\',this.value)\" title=\"Rename catalog\"/>'+",
    "          '<div class=\"catalog-row-type\">'+c.type+'</div>'+",
    "        '</div>'+",
    "        '<label class=\"toggle\"><input type=\"checkbox\" '+(checked?'checked':'')+' onchange=\"setCatalogEnabled(\\''+ c.id +'\\',this.checked)\"/><span class=\"toggle-slider\"></span></label>'+",
    "      '</div>';",
    "    }).join('');",
    "  });",
    "}",
    "function setCatalogEnabled(id,val){ state.catalogEnabled[id]=val; }",
    "function setCatalogName(id,val){ state.catalogNames[id]=val; }",
    "",
    "function toggleCatalogSection(type) {",
    "  var body=document.getElementById('cat-section-body-'+type);",
    "  var hdr=document.getElementById('cat-section-hdr-'+type);",
    "  if(!body||!hdr) return;",
    "  var collapsed=body.classList.toggle('collapsed');",
    "  hdr.classList.toggle('collapsed',collapsed);",
    "}",
    "",
    // ── Custom catalog (TMDB Discover) ──
    "function toggleCustomCatalogForm(type) {",
    "  var form=document.getElementById('custom-catalog-form-'+type);",
    "  if(!form) return;",
    "  form.classList.toggle('open');",
    "  if(form.classList.contains('open')) loadGenresForCustom(type);",
    "}",
    "async function loadGenresForCustom(type) {",
    "  var tt=(type==='series'?'tv':'movie');",
    "  if(genreCache[tt]){ populateGenreSelect(genreCache[tt],type); return; }",
    "  try {",
    "    var r=await fetch('/api/genres?apiKey='+encodeURIComponent(state.apiKey)+'&type='+tt);",
    "    var d=await r.json();",
    "    genreCache[tt]=d.genres||[]; populateGenreSelect(genreCache[tt],type);",
    "  } catch(e){}",
    "}",
    "function populateGenreSelect(genres,type) {",
    "  var sel=document.getElementById('cc-genre-'+type);",
    "  if(!sel) return;",
    "  sel.innerHTML='<option value=\"\">Any Genre</option>'+genres.map(function(g){ return '<option value=\"'+g.id+'\">'+esc(g.name)+'</option>'; }).join('');",
    "}",
    "function addCustomCatalog(type) {",
    "  var name=document.getElementById('cc-name-'+type).value.trim();",
    "  var genre=document.getElementById('cc-genre-'+type).value;",
    "  var sort=document.getElementById('cc-sort-'+type).value;",
    "  if(!name){ var n=document.getElementById('cc-name-'+type); n.classList.add('error'); setTimeout(function(){ n.classList.remove('error'); },1500); return; }",
    "  var tt=(type==='series'?'tv':'movie');",
    "  var params={sort_by:sort};",
    "  if(genre) params.with_genres=genre;",
    "  state.customCatalogs.push({id:'custom.'+Date.now(),name:name,type:type,path:'/discover/'+tt,params:params,enabled:true});",
    "  document.getElementById('cc-name-'+type).value='';",
    "  document.getElementById('custom-catalog-form-'+type).classList.remove('open');",
    "  renderCustomCatalogsList();",
    "}",
    "function removeCustomCatalog(id){ state.customCatalogs=state.customCatalogs.filter(function(c){ return c.id!==id; }); renderCustomCatalogsList(); }",
    "function renderCustomCatalogsList() {",
    "  var el=document.getElementById('custom-catalogs-list');",
    "  if(!state.customCatalogs.length){ el.innerHTML='<div class=\"empty-state\">No custom catalogs yet.</div>'; return; }",
    "  var sortLabels={'popularity.desc':'Popular','vote_average.desc':'Top Rated','release_date.desc':'Newest','revenue.desc':'Revenue'};",
    "  el.innerHTML=state.customCatalogs.map(function(c){",
    "    var srcLabel=c.path==='_mdblist_'?'MDBList':c.path==='_imdb_'?'IMDB List':c.path==='_handpicked_'?'Handpicked (' +(c.items||[]).length+')': ((c.params&&sortLabels[c.params.sort_by])||'Custom');",
    "    var gp=c.params&&c.params.with_genres?' \u00b7 Genre '+c.params.with_genres:'';",
    "    return '<div class=\"custom-catalog-item\"><div class=\"custom-catalog-item-info\"><div class=\"custom-catalog-item-name\">'+esc(c.name)+'</div><div class=\"custom-catalog-item-sub\">'+c.type+' \u00b7 '+srcLabel+gp+'</div></div><button class=\"btn btn-danger btn-sm\" onclick=\"removeCustomCatalog(\\''+ c.id +'\\')\">\u00d7</button></div>';",
    "  }).join('');",
    "}",
    "",
    // ── MDBList catalog ──
    "var mdbCatalogPreviewData=null;",
    "async function previewMdbCatalog(type) {",
    "  var input=document.getElementById('mdb-cat-url-'+type);",
    "  var status=document.getElementById('mdb-cat-status-'+type);",
    "  var btn=document.getElementById('mdb-cat-btn-'+type);",
    "  var preview=document.getElementById('mdb-cat-preview-'+type);",
    "  var url=(input?input.value:'').trim();",
    "  if(!url){ status.textContent='Please enter an MDBList URL'; status.style.color='var(--danger)'; return; }",
    "  btn.disabled=true; btn.innerHTML='<span class=\"spinner-light\"></span>';",
    "  status.textContent='Fetching list\u2026'; status.style.color='var(--text-mute)';",
    "  preview.style.display='none'; mdbCatalogPreviewData=null;",
    "  try {",
    "    var r=await fetch('/api/mdblist-catalog?url='+encodeURIComponent(url)+'&apiKey='+encodeURIComponent(state.apiKey));",
    "    var d=await r.json();",
    "    if(d.error) throw new Error(d.error);",
    "    if(!d.metas||!d.metas.length) throw new Error('No movies or shows found.');",
    "    mdbCatalogPreviewData={url:url,metas:d.metas,name:d.name,count:d.count,type:type};",
    "    var nameInput=document.getElementById('mdb-cat-name-'+type);",
    "    if(d.name) nameInput.value=d.name;",
    "    var thumbs=d.metas.slice(0,8).map(function(m){ return m.poster?'<img src=\"'+m.poster+'\" style=\"width:36px;height:54px;border-radius:5px;object-fit:cover;\" loading=\"lazy\"/>':''; }).join('');",
    "    document.getElementById('mdb-cat-thumbs-'+type).innerHTML=thumbs;",
    "    status.textContent=d.count+' item'+(d.count!==1?'s':'')+' found'+(d.name?' \u2014 '+d.name:'');",
    "    status.style.color='var(--gold)'; preview.style.display='block';",
    "  } catch(e){ status.textContent='Error: '+e.message; status.style.color='#e05252'; }",
    "  finally{ btn.disabled=false; btn.textContent='Preview'; }",
    "}",
    "function addMdbCatalog(type) {",
    "  if(!mdbCatalogPreviewData||mdbCatalogPreviewData.type!==type) return;",
    "  var name=document.getElementById('mdb-cat-name-'+type).value.trim()||'MDBList';",
    "  state.customCatalogs.push({id:'mdblist.'+Date.now(),name:name,type:type,path:'_mdblist_',mdblistUrl:mdbCatalogPreviewData.url,enabled:true});",
    "  document.getElementById('mdb-cat-url-'+type).value='';",
    "  document.getElementById('mdb-cat-preview-'+type).style.display='none';",
    "  document.getElementById('mdb-cat-status-'+type).textContent='\u2713 Added \"'+name+'\"';",
    "  document.getElementById('mdb-cat-status-'+type).style.color='var(--gold)';",
    "  mdbCatalogPreviewData=null; renderCustomCatalogsList();",
    "}",
    "",
    // ── IMDB catalog ──
    "var imdbCatalogPreviewData=null;",
    "async function previewImdbCatalog(type) {",
    "  var input=document.getElementById('imdb-cat-url-'+type);",
    "  var status=document.getElementById('imdb-cat-status-'+type);",
    "  var btn=document.getElementById('imdb-cat-btn-'+type);",
    "  var preview=document.getElementById('imdb-cat-preview-'+type);",
    "  var url=(input?input.value:'').trim();",
    "  if(!url){ status.textContent='Please enter an IMDB list URL'; status.style.color='var(--danger)'; return; }",
    "  btn.disabled=true; btn.innerHTML='<span class=\"spinner-light\"></span>';",
    "  status.textContent='Fetching list\u2026'; status.style.color='var(--text-mute)';",
    "  preview.style.display='none'; imdbCatalogPreviewData=null;",
    "  try {",
    "    var r=await fetch('/api/imdb-catalog?url='+encodeURIComponent(url)+'&apiKey='+encodeURIComponent(state.apiKey));",
    "    var d=await r.json();",
    "    if(d.error) throw new Error(d.error);",
    "    if(!d.metas||!d.metas.length) throw new Error('No titles resolved from this list.');",
    "    imdbCatalogPreviewData={url:url,metas:d.metas,name:d.name,count:d.count,type:type};",
    "    var nameInput=document.getElementById('imdb-cat-name-'+type);",
    "    if(d.name) nameInput.value=d.name;",
    "    var thumbs=d.metas.slice(0,8).map(function(m){ return m.poster?'<img src=\"'+m.poster+'\" style=\"width:36px;height:54px;border-radius:5px;object-fit:cover;\" loading=\"lazy\"/>':''; }).join('');",
    "    document.getElementById('imdb-cat-thumbs-'+type).innerHTML=thumbs;",
    "    status.textContent=d.count+' titles found'+(d.name?' \u2014 '+d.name:'');",
    "    status.style.color='var(--gold)'; preview.style.display='block';",
    "  } catch(e){ status.textContent='Error: '+e.message; status.style.color='#e05252'; }",
    "  finally{ btn.disabled=false; btn.textContent='Preview'; }",
    "}",
    "function addImdbCatalog(type) {",
    "  if(!imdbCatalogPreviewData||imdbCatalogPreviewData.type!==type) return;",
    "  var name=document.getElementById('imdb-cat-name-'+type).value.trim()||'IMDB List';",
    "  state.customCatalogs.push({id:'imdb.'+Date.now(),name:name,type:type,path:'_imdb_',imdbListUrl:imdbCatalogPreviewData.url,enabled:true});",
    "  document.getElementById('imdb-cat-url-'+type).value='';",
    "  document.getElementById('imdb-cat-preview-'+type).style.display='none';",
    "  document.getElementById('imdb-cat-status-'+type).textContent='\u2713 Added \"'+name+'\"';",
    "  document.getElementById('imdb-cat-status-'+type).style.color='var(--gold)';",
    "  imdbCatalogPreviewData=null; renderCustomCatalogsList();",
    "}",
    "",
    // ── Handpicked catalog ──
    "var handpickedSearchTimer;",
    "function debounceHandpickedSearch(q,type) {",
    "  clearTimeout(handpickedSearchTimer);",
    "  if(!q.trim()){ document.getElementById('handpicked-results-'+type).innerHTML=''; return; }",
    "  handpickedSearchTimer=setTimeout(function(){ doHandpickedSearch(q,type); },350);",
    "}",
    "async function doHandpickedSearch(q,type) {",
    "  var box=document.getElementById('handpicked-results-'+type);",
    "  box.innerHTML='<div class=\"loading-state\" style=\"padding:8px\"><div class=\"spinner-light\"></div></div>';",
    "  try {",
    "    var r=await fetch('/api/tmdb-search?q='+encodeURIComponent(q)+'&apiKey='+encodeURIComponent(state.apiKey));",
    "    var d=await r.json();",
    "    if(!d.results||!d.results.length){ box.innerHTML='<p style=\"padding:8px;font-size:0.78rem;color:var(--text-mute)\">No results.</p>'; return; }",
    "    var filtered=d.results.filter(function(s){ return s.type===(type==='series'?'series':'movie'); });",
    "    if(!filtered.length){ box.innerHTML='<p style=\"padding:8px;font-size:0.78rem;color:var(--text-mute)\">No '+type+' results.</p>'; return; }",
    "    box.innerHTML=filtered.map(function(s){",
    "      var img=s.poster?'<img src=\"'+s.poster+'\" alt=\"\" loading=\"lazy\"/>' : '<img src=\"\" alt=\"\" style=\"background:var(--surface2)\" loading=\"lazy\"/>';",
    "      return '<div class=\"handpicked-item\" onclick=\"addHandpickedItem('+s.id+',\\''+ esc4attr(s.name) +'\\',\\''+ esc4attr(s.poster||'') +'\\',\\''+type+'\\')\">'+img+'<div class=\"handpicked-item-info\"><div class=\"handpicked-item-name\">'+esc(s.name)+'</div><div class=\"handpicked-item-meta\">'+(s.year||'')+'</div></div></div>';",
    "    }).join('');",
    "  } catch(e){ box.innerHTML='<p style=\"padding:8px;color:var(--text-mute)\">Error.</p>'; }",
    "}",
    "var handpickedByType={'movie':[],'series':[]};",
    "function addHandpickedItem(tmdbId,name,poster,type) {",
    "  if(!handpickedByType[type]) handpickedByType[type]=[];",
    "  if(handpickedByType[type].find(function(i){ return i.tmdbId===String(tmdbId); })) return;",
    "  handpickedByType[type].push({tmdbId:String(tmdbId),name:name,poster:poster,type:type});",
    "  renderHandpickedTags(type);",
    "}",
    "function removeHandpickedItem(tmdbId,type) {",
    "  handpickedByType[type]=handpickedByType[type].filter(function(i){ return i.tmdbId!==String(tmdbId); });",
    "  renderHandpickedTags(type);",
    "}",
    "function renderHandpickedTags(type) {",
    "  var el=document.getElementById('handpicked-tags-'+type);",
    "  if(!el) return;",
    "  var items=handpickedByType[type]||[];",
    "  el.innerHTML=items.map(function(item){ return '<span class=\"handpicked-tag\">'+esc(item.name)+'<button onclick=\"removeHandpickedItem(\\''+item.tmdbId+'\\',\\''+type+'\\')\">\u00d7</button></span>'; }).join('');",
    "}",
    "function addHandpickedCatalog(type) {",
    "  var name=document.getElementById('handpicked-name-'+type).value.trim();",
    "  var items=handpickedByType[type]||[];",
    "  if(!name){ var n=document.getElementById('handpicked-name-'+type); n.classList.add('error'); setTimeout(function(){ n.classList.remove('error'); },1500); return; }",
    "  if(!items.length){ alert('Search and add some titles first.'); return; }",
    "  state.customCatalogs.push({id:'handpicked.'+Date.now(),name:name,type:type,path:'_handpicked_',items:items.map(function(i){ return {tmdbId:i.tmdbId,type:i.type}; }),enabled:true});",
    "  document.getElementById('handpicked-name-'+type).value='';",
    "  handpickedByType[type]=[];",
    "  renderHandpickedTags(type);",
    "  document.getElementById('handpicked-search-'+type).value='';",
    "  document.getElementById('handpicked-results-'+type).innerHTML='';",
    "  renderCustomCatalogsList();",
    "}",
    "",
    // ── Episode lists ──
    "function getList(listId){ return state.customSeasons.find(function(l){ return l.listId===listId; }); }",
    "function updateListMeta(listId,field,value) {",
    "  var list=getList(listId); if(list) list[field]=value;",
    "  var nameEl=document.getElementById('show-name-display-'+listId);",
    "  if(nameEl&&list) nameEl.textContent=(list.prefix||'\u2728')+' '+(list.label||'Best Of')+' \u2014 '+list.tmdbName;",
    "}",
    "function removeList(listId){ state.customSeasons=state.customSeasons.filter(function(l){ return l.listId!==listId; }); renderCustomSeasonsList(); }",
    "function removeEp(listId,idx){ var list=getList(listId); if(!list) return; list.episodes.splice(idx,1); renderListEpisodes(listId); updateEpCount(listId); }",
    "function toggleShowCard(listId){ var card=document.getElementById('show-'+listId); if(card) card.classList.toggle('expanded'); }",
    "function updateEpCount(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  var badge=document.getElementById('ep-count-'+listId);",
    "  if(badge){ badge.textContent=list.episodes.length+' ep'+(list.episodes.length!==1?'s':''); badge.className='ep-count-badge'+(list.episodes.length>0?' has-eps':''); }",
    "}",
    "",
    "function renderListEpisodes(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  var el=document.getElementById('eplist-'+listId); if(!el) return;",
    "  if(!list.episodes.length){ el.innerHTML='<li class=\"ep-list-empty\">No episodes yet. Use the tabs above to add some.</li>'; return; }",
    "  el.innerHTML=list.episodes.map(function(ep,i){",
    "    var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'0');",
    "    var th=ep.still?'<img class=\"ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading=\"lazy\"/>':'<div class=\"ep-thumb\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#127902;</div>';",
    "    return '<li class=\"ep-item\" draggable=\"true\" data-lid=\"'+listId+'\" data-idx=\"'+i+'\"><span class=\"ep-rank\">'+(i+1)+'</span><span class=\"ep-drag\">&#8801;</span>'+th+'<div class=\"ep-info\"><div class=\"ep-label\">S'+sL+'E'+eL+' \u2014 '+esc(ep.name||('S'+sL+'E'+eL))+'</div><div class=\"ep-sublabel\">'+(ep.air_date||'')+'</div></div>'+(ep.vote_average>0?'<span class=\"ep-rating\">\u2605'+ep.vote_average.toFixed(1)+'</span>':'')+'<span class=\"ep-del\" onclick=\"removeEp(\\''+ listId +'\\','+i+')\">\u00d7</span></li>';",
    "  }).join('');",
    "  initDragSort(listId);",
    "}",
    "",
    "function renderCustomSeasonsList() {",
    "  var el=document.getElementById('custom-seasons-list');",
    "  if(!state.customSeasons.length){ el.innerHTML='<div class=\"empty-state\">No shows yet. Search above to get started.</div>'; return; }",
    "  el.innerHTML=state.customSeasons.map(function(list){",
    "    var tid=list.listId;",
    "    var ph=list.tmdbPoster?'<img class=\"show-poster\" src=\"'+list.tmdbPoster+'\" alt=\"\" loading=\"lazy\"/>':'<div class=\"show-poster\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#128250;</div>';",
    "    var displayName=(list.prefix||'\u2728')+' '+(list.label||'Best Of')+' \u2014 '+list.tmdbName;",
    "    var epItems=list.episodes.length?",
    "      list.episodes.map(function(ep,i){",
    "        var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'0');",
    "        var th=ep.still?'<img class=\"ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading=\"lazy\"/>':'<div class=\"ep-thumb\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#127902;</div>';",
    "        return '<li class=\"ep-item\" draggable=\"true\" data-lid=\"'+tid+'\" data-idx=\"'+i+'\"><span class=\"ep-rank\">'+(i+1)+'</span><span class=\"ep-drag\">&#8801;</span>'+th+'<div class=\"ep-info\"><div class=\"ep-label\">S'+sL+'E'+eL+' \u2014 '+esc(ep.name||('S'+sL+'E'+eL))+'</div><div class=\"ep-sublabel\">'+(ep.air_date||'')+'</div></div>'+(ep.vote_average>0?'<span class=\"ep-rating\">\u2605'+ep.vote_average.toFixed(1)+'</span>':'')+'<span class=\"ep-del\" onclick=\"removeEp(\\''+ tid +'\\','+i+')\">\u00d7</span></li>';",
    "      }).join(''):",
    "      '<li class=\"ep-list-empty\">No episodes yet. Use the tabs above to add some.</li>';",
    "    var hasCnt=list.episodes.length>0;",
    "    return '<div class=\"show-card\" id=\"show-'+tid+'\">'+",
    "      '<div class=\"show-card-header\">'+ph+",
    "        '<div class=\"show-card-info\"><div class=\"show-card-name\" id=\"show-name-display-'+tid+'\">'+esc(displayName)+'</div><div class=\"show-card-sub\">'+esc(list.tmdbName)+'</div></div>'+",
    "        '<div class=\"show-card-actions\"><span class=\"ep-count-badge'+(hasCnt?' has-eps':'')+' \" id=\"ep-count-'+tid+'\">'+list.episodes.length+' ep'+(list.episodes.length!==1?'s':'')+'</span>'+",
    "          '<button class=\"btn btn-ghost btn-sm\" onclick=\"toggleShowCard(\\''+ tid +'\\')\" style=\"min-width:32px\">\u22ef</button></div>'+",
    "      '</div>'+",
    "      '<div class=\"show-ep-body\">'+",
    "        '<div style=\"padding:14px 16px 0;\"><div class=\"show-rename-row\">'+",
    "          '<input class=\"show-rename-prefix\" type=\"text\" value=\"'+esc(list.prefix||'\u2728')+'\" placeholder=\"\u2728\" oninput=\"updateListMeta(\\''+ tid +'\\',\\'prefix\\',this.value)\" title=\"Prefix emoji\"/>'+",
    "          '<input class=\"show-rename-label\" type=\"text\" value=\"'+esc(list.label||'Best Of')+'\" placeholder=\"List name\" oninput=\"updateListMeta(\\''+ tid +'\\',\\'label\\',this.value)\"/>'+",
    "          '<button class=\"btn btn-danger btn-sm\" onclick=\"removeList(\\''+ tid +'\\')\">\u00d7</button>'+",
    "        '</div></div>'+",
    "        '<div class=\"add-tabs\">'+",
    "          '<button class=\"add-tab active\" id=\"add-tab-picker-'+tid+'\" onclick=\"switchAddTab(\\''+ tid +'\\',\\'picker\\')\">Browse</button>'+",
    "          '<button class=\"add-tab\" id=\"add-tab-imdb-'+tid+'\" onclick=\"switchAddTab(\\''+ tid +'\\',\\'imdb\\')\">IMDB List</button>'+",
    "          '<button class=\"add-tab\" id=\"add-tab-paste-'+tid+'\" onclick=\"switchAddTab(\\''+ tid +'\\',\\'paste\\')\">Paste</button>'+",
    "        '</div>'+",
    "        '<div class=\"add-panel active\" id=\"add-panel-picker-'+tid+'\"><button class=\"btn btn-ghost btn-sm\" style=\"width:100%\" onclick=\"openModal(\\''+ tid +'\\')\" >Browse &amp; select episodes\u2026</button></div>'+",
    "        '<div class=\"add-panel\" id=\"add-panel-imdb-'+tid+'\">'+",
    "          '<div class=\"import-row\"><input type=\"text\" id=\"imdb-url-'+tid+'\" placeholder=\"https://www.imdb.com/list/ls086682535/\"/><button class=\"btn btn-ghost btn-sm\" id=\"imdb-btn-'+tid+'\" onclick=\"importImdbList(\\''+ tid +'\\')\" >Import</button></div>'+",
    "          '<div class=\"import-status\" id=\"imdb-status-'+tid+'\"></div>'+",
    "        '</div>'+",
    "        '<div class=\"add-panel\" id=\"add-panel-paste-'+tid+'\">'+",
    "          '<p class=\"paste-hint\">Accepts S01E01, s1e1, 1x01 and similar formats.</p>'+",
    "          '<textarea id=\"paste-input-'+tid+'\" placeholder=\"S01E01\nS01E05\nS02E03\"></textarea>'+",
    "          '<div class=\"paste-actions\"><button class=\"btn btn-primary btn-sm\" onclick=\"applyPaste(\\''+ tid +'\\')\">\u2713 Add</button><span class=\"paste-status\" id=\"paste-status-'+tid+'\"></span></div>'+",
    "        '</div>'+",
    "        '<div style=\"padding:0 16px 16px;\"><ul class=\"ep-list mt-2\" id=\"eplist-'+tid+'\">'+epItems+'</ul></div>'+",
    "      '</div>'+",
    "    '</div>';",
    "  }).join('');",
    "  state.customSeasons.forEach(function(list){ initDragSort(list.listId); });",
    "}",
    "",
    // ── Drag sort (mouse + touch) ──
    "function initDragSort(listId) {",
    "  var listEl=document.getElementById('eplist-'+listId); if(!listEl) return;",
    "  var dragIdx=null;",
    "  function getItemAtY(y) {",
    "    var items=Array.from(listEl.querySelectorAll('.ep-item'));",
    "    for(var i=0;i<items.length;i++){",
    "      var rect=items[i].getBoundingClientRect();",
    "      if(y>=rect.top&&y<=rect.bottom) return parseInt(items[i].dataset.idx);",
    "    }",
    "    if(items.length>0){",
    "      var lastRect=items[items.length-1].getBoundingClientRect();",
    "      if(y>lastRect.bottom) return parseInt(items[items.length-1].dataset.idx);",
    "      return parseInt(items[0].dataset.idx);",
    "    }",
    "    return -1;",
    "  }",
    "  listEl.querySelectorAll('.ep-item').forEach(function(item,idx){",
    "    // Mouse drag",
    "    item.addEventListener('dragstart',function(e){ dragIdx=idx; item.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; });",
    "    item.addEventListener('dragend',function(){ item.classList.remove('dragging'); });",
    "    item.addEventListener('dragover',function(e){ e.preventDefault(); listEl.querySelectorAll('.ep-item').forEach(function(i){ i.classList.remove('drag-over'); }); item.classList.add('drag-over'); });",
    "    item.addEventListener('dragleave',function(){ item.classList.remove('drag-over'); });",
    "    item.addEventListener('drop',function(e){",
    "      e.preventDefault(); item.classList.remove('drag-over');",
    "      var dropIdx=parseInt(item.dataset.idx);",
    "      if(dragIdx===null||dragIdx===dropIdx) return;",
    "      var list=getList(listId); if(!list) return;",
    "      var moved=list.episodes.splice(dragIdx,1)[0];",
    "      list.episodes.splice(dropIdx,0,moved);",
    "      dragIdx=null; renderListEpisodes(listId); updateEpCount(listId);",
    "    });",
    "    // Touch drag (handle grip icon to avoid scroll conflict)",
    "    var grip=item.querySelector('.ep-drag');",
    "    var touchSource=grip||item;",
    "    touchSource.addEventListener('touchstart',function(e){",
    "      dragIdx=idx; item.classList.add('dragging');",
    "    },{passive:true});",
    "    touchSource.addEventListener('touchmove',function(e){",
    "      if(dragIdx===null) return;",
    "      e.preventDefault();",
    "      var y=e.touches[0].clientY;",
    "      listEl.querySelectorAll('.ep-item').forEach(function(i){ i.classList.remove('drag-over'); });",
    "      var overIdx=getItemAtY(y);",
    "      if(overIdx>=0){ var overItem=listEl.querySelectorAll('.ep-item')[overIdx]; if(overItem) overItem.classList.add('drag-over'); }",
    "    },{passive:false});",
    "    touchSource.addEventListener('touchend',function(e){",
    "      if(dragIdx===null) return;",
    "      item.classList.remove('dragging');",
    "      listEl.querySelectorAll('.ep-item').forEach(function(i){ i.classList.remove('drag-over'); });",
    "      var y=e.changedTouches[0].clientY;",
    "      var dropIdx=getItemAtY(y);",
    "      if(dropIdx>=0&&dropIdx!==dragIdx){",
    "        var list=getList(listId); if(!list) return;",
    "        var moved=list.episodes.splice(dragIdx,1)[0];",
    "        list.episodes.splice(dropIdx,0,moved);",
    "        renderListEpisodes(listId); updateEpCount(listId);",
    "      }",
    "      dragIdx=null;",
    "    },{passive:true});",
    "  });",
    "}",
    "",
    // ── Modal ──
    "async function openModal(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  modalData.listId=listId; modalData.tmdbId=list.tmdbId; modalData.allEpisodes=[]; modalData.filteredSeason='all';",
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
    "    if(d.error) throw new Error(d.error);",
    "    modalData.allEpisodes=d.episodes;",
    "    document.getElementById('modal-show-sub').textContent=d.show.seasons+' season'+(d.show.seasons!==1?'s':'')+' \u2014 '+d.episodes.length+' episodes';",
    "    var seasons=[]; d.episodes.forEach(function(e){ if(seasons.indexOf(e.season)===-1) seasons.push(e.season); }); seasons.sort(function(a,b){return a-b;});",
    "    var filters=document.getElementById('modal-season-filters');",
    "    var btns=['<button class=\"season-btn active\" onclick=\"setSeasonFilter(\\'all\\',this)\">All</button>'];",
    "    seasons.forEach(function(s){ btns.push('<button class=\"season-btn\" onclick=\"setSeasonFilter('+s+',this)\">S'+s+'</button>'); });",
    "    filters.innerHTML=btns.join(''); renderModalEpisodes();",
    "  } catch(e){ document.getElementById('modal-ep-list').innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">Error: '+esc(e.message)+'</p>'; }",
    "}",
    "function setSeasonFilter(val,btn){ modalData.filteredSeason=val; document.querySelectorAll('.season-btn').forEach(function(b){ b.classList.remove('active'); }); btn.classList.add('active'); renderModalEpisodes(); }",
    "function renderModalEpisodes() {",
    "  var eps=modalData.filteredSeason==='all'?modalData.allEpisodes:modalData.allEpisodes.filter(function(e){ return e.season===modalData.filteredSeason; });",
    "  var list=document.getElementById('modal-ep-list');",
    "  if(!eps.length){ list.innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">No episodes.</p>'; return; }",
    "  list.innerHTML=eps.map(function(ep){",
    "    var key=ep.season+':'+ep.episode; var sel=modalData.selected.has(key);",
    "    var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'0');",
    "    var th=ep.still?'<img class=\"modal-ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading=\"lazy\"/>':'<div class=\"modal-ep-thumb\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#127902;</div>';",
    "    return '<div class=\"modal-ep-item'+(sel?' selected':'')+' \" onclick=\"toggleEp(\\''+ key +'\\',this)\">'+th+'<div class=\"modal-ep-info\"><div class=\"modal-ep-name\">S'+sL+'E'+eL+' \u2014 '+esc(ep.name)+'</div><div class=\"modal-ep-meta\">'+(ep.vote_average>0?'\u2605 '+ep.vote_average.toFixed(1)+' &middot; ':'')+( ep.air_date||'')+'</div></div><div class=\"modal-ep-check\">'+(sel?'&#10003;':'')+'</div></div>';",
    "  }).join('');",
    "}",
    "function toggleEp(key,el){ if(modalData.selected.has(key)){ modalData.selected.delete(key); el.classList.remove('selected'); el.querySelector('.modal-ep-check').innerHTML=''; } else { modalData.selected.add(key); el.classList.add('selected'); el.querySelector('.modal-ep-check').innerHTML='&#10003;'; } updateModalCount(); }",
    "function updateModalCount(){ document.getElementById('modal-sel-count').textContent=modalData.selected.size; }",
    "function addSelectedEpisodes() {",
    "  var list=getList(modalData.listId); if(!list){ closeModal(); return; }",
    "  var keys=Array.from(modalData.selected);",
    "  var episodes=keys.map(function(k){ var p=k.split(':').map(Number); return modalData.allEpisodes.find(function(ep){ return ep.season===p[0]&&ep.episode===p[1]; }); }).filter(Boolean);",
    "  var existingKeys=new Set(list.episodes.map(function(e){ return e.season+':'+e.episode; }));",
    "  var kept=list.episodes.filter(function(e){ return keys.indexOf(e.season+':'+e.episode)!==-1; });",
    "  var newEps=episodes.filter(function(e){ return !existingKeys.has(e.season+':'+e.episode); });",
    "  list.episodes=kept.concat(newEps);",
    "  closeModal(); renderListEpisodes(modalData.listId); updateEpCount(modalData.listId);",
    "}",
    "function closeModal(){ document.getElementById('modal-backdrop').classList.remove('open'); document.body.style.overflow=''; }",
    "function closeModalOnBackdrop(e){ if(e.target===document.getElementById('modal-backdrop')) closeModal(); }",
    "",
    // ── IMDB episode import (FIXED) ──
    "async function importImdbList(listId) {",
    "  var list=getList(listId); if(!list) return;",
    "  var input=document.getElementById('imdb-url-'+listId);",
    "  var btn=document.getElementById('imdb-btn-'+listId);",
    "  var status=document.getElementById('imdb-status-'+listId);",
    "  var url=(input?input.value:'').trim();",
    "  if(!url){ if(status){ status.textContent='Please enter an IMDB list URL'; status.className='import-status err'; } return; }",
    "  if(btn){ btn.disabled=true; btn.innerHTML='<span class=\"spinner\"></span>'; }",
    "  if(status){ status.textContent='Fetching\u2026'; status.className='import-status'; }",
    "  try {",
    "    var r=await fetch('/api/imdb-list?url='+encodeURIComponent(url)+'&apiKey='+encodeURIComponent(state.apiKey)+'&tmdbId='+list.tmdbId);",
    "    var d=await r.json();",
    "    if(d.error) throw new Error(d.error);",
    "    if(!d.episodes||!d.episodes.length) throw new Error('No matching episodes found for this show.');",
    "    var existingKeys=new Set(list.episodes.map(function(e){ return e.season+':'+e.episode; }));",
    "    var allEpsForShow=modalData.tmdbId===list.tmdbId?modalData.allEpisodes:[];",
    "    var added=0;",
    "    for(var i=0;i<d.episodes.length;i++){",
    "      var ref=d.episodes[i]; var key=ref.season+':'+ref.episode;",
    "      if(!existingKeys.has(key)){ existingKeys.add(key); var full=allEpsForShow.find(function(e){ return e.season===ref.season&&e.episode===ref.episode; }); list.episodes.push(full||ref); added++; }",
    "    }",
    "    var msg='Added '+added+' episode'+(added!==1?'s':'');",
    "    if(d.skipped) msg+=' ('+d.skipped+' not found)';",
    "    if(status){ status.textContent=msg; status.className='import-status ok'; }",
    "    if(input) input.value='';",
    "    renderListEpisodes(listId); updateEpCount(listId);",
    "  } catch(e){ if(status){ status.textContent='Error: '+e.message; status.className='import-status err'; } }",
    "  finally{ if(btn){ btn.disabled=false; btn.textContent='Import'; } }",
    "}",
    "",
    // ── Season Zero ──
    "function toggleSzeroExpand() {",
    "  var card=document.getElementById('szero-card');",
    "  card.classList.toggle('expanded');",
    "  var btn=document.getElementById('szero-expand-btn');",
    "  btn.textContent=card.classList.contains('expanded')?'Collapse \u25b2':'Configure \u25be';",
    "}",
    "",
    // ── Search for shows ──
    "var searchTimer;",
    "function debounceSearch(q) {",
    "  clearTimeout(searchTimer);",
    "  if(!q.trim()){ document.getElementById('search-results').classList.remove('visible'); return; }",
    "  searchTimer=setTimeout(function(){ doSearch(q); },350);",
    "}",
    "async function doSearch(q) {",
    "  var box=document.getElementById('search-results');",
    "  box.classList.add('visible');",
    "  box.innerHTML='<div class=\"loading-state\"><div class=\"spinner-light\"></div> Searching...</div>';",
    "  try {",
    "    var r=await fetch('/api/search?q='+encodeURIComponent(q)+'&apiKey='+encodeURIComponent(state.apiKey)+'&type=tv');",
    "    var d=await r.json();",
    "    if(!d.results||!d.results.length){ box.innerHTML='<p style=\"padding:1rem;font-size:0.82rem;color:var(--text-mute)\">No results.</p>'; return; }",
    "    box.innerHTML=d.results.map(function(s){",
    "      var ph=s.poster?'<img class=\"search-poster\" src=\"'+s.poster+'\" alt=\"\" loading=\"lazy\"/>':'<div class=\"search-poster\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#128250;</div>';",
    "      return '<div class=\"search-result-item\" onclick=\"addShowToList('+s.id+',\\''+esc4attr(s.name)+'\\',\\''+esc4attr(s.poster||'')+'\\')\">'+ph+'<div><div class=\"search-name\">'+esc(s.name)+'</div><div class=\"search-meta\">'+(s.year?s.year+' &middot; ':'')+'\u2605 '+s.vote_average+'</div></div></div>';",
    "    }).join('');",
    "  } catch(e){ box.innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">Error searching.</p>'; }",
    "}",
    "function addShowToList(tmdbId,name,poster) {",
    "  var listId=uid();",
    "  state.customSeasons.push({listId:listId,tmdbId:String(tmdbId),tmdbName:name,tmdbPoster:poster,label:'Best Of',prefix:'\u2728',episodes:[]});",
    "  document.getElementById('search-results').classList.remove('visible');",
    "  document.getElementById('series-search').value='';",
    "  renderCustomSeasonsList();",
    "  setTimeout(function(){ var card=document.getElementById('show-'+listId); if(card) card.classList.add('expanded'); },50);",
    "}",
    "",
    // ── Install page ──
    "function buildInstallPage() {",
    "  var flat=state.customSeasons.map(function(list){",
    "    return {listId:list.listId,tmdbId:list.tmdbId,label:list.label||'Best Of',prefix:list.prefix||'\u2728',episodes:list.episodes.map(function(e){ return {season:e.season,episode:e.episode}; })};",
    "  });",
    "  state.topN=parseInt(document.getElementById('topN').value)||20;",
    "  state.showAutoSeason=document.getElementById('showAutoSeason').checked;",
    "  var cfg={tmdbApiKey:state.apiKey,topN:state.topN,showAutoSeason:state.showAutoSeason,customSeasons:flat,catalogEnabled:state.catalogEnabled,catalogNames:state.catalogNames,customCatalogs:state.customCatalogs};",
    "  var encoded=btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));",
    "  var manifestUrl=window.location.origin+'/'+encoded+'/manifest.json';",
    "  document.getElementById('manifest-url').value=manifestUrl;",
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
    "  if(allThumbs.length){",
    "    var thumbsHtml=allThumbs.concat(allThumbs).map(function(src){ return src?'<img class=\"parade-thumb\" src=\"'+src+'\" alt=\"\" loading=\"lazy\"/>':''; }).join('');",
    "    document.getElementById('ep-parade').innerHTML='<div class=\"ep-parade-track\">'+thumbsHtml+'</div>';",
    "    document.getElementById('ep-parade').style.display='flex';",
    "  } else { document.getElementById('ep-parade').style.display='none'; }",
    "}",
    "function openStremio(){ var url=document.getElementById('manifest-url').value; if(!url) return; window.location.href=url.replace(/^https?:\\/\\//,'stremio://'); }",
    "function copyUrl(){",
    "  var input=document.getElementById('manifest-url'); input.select();",
    "  try{document.execCommand('copy');}catch(e){navigator.clipboard&&navigator.clipboard.writeText(input.value);}",
    "  var btn=document.getElementById('copy-btn'); btn.textContent='Copied!'; btn.classList.add('copied');",
    "  setTimeout(function(){ btn.textContent='Copy'; btn.classList.remove('copied'); },2000);",
    "}",
    "",
    // ── Hero background ──
    "async function loadHeroBg() {",
    "  try {",
    "    var r=await fetch('/api/featured');",
    "    var d=await r.json();",
    "    if(!d.posters||!d.posters.length) return;",
    "    var posters=d.posters;",
    "    var doubled=posters.concat(posters);",
    "    var track=document.getElementById('hero-bg-track');",
    "    if(!track) return;",
    "    track.innerHTML=doubled.map(function(src){ return '<img class=\"hero-bg-img\" src=\"'+src+'\" alt=\"\" loading=\"lazy\"/>'; }).join('');",
    "  } catch(e){}",
    "}",
    "window.addEventListener('DOMContentLoaded', loadHeroBg);",
    "",
    "function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }",
    "function esc4attr(s){ return String(s||'').replace(/'/g,'&#39;'); }",
  ].join('\n');

  // ── Catalog section helper ──
  function catalogImportSection(type) {
    const typeLabel = type === 'movie' ? 'Movie' : 'Series';
    const typeIcon  = type === 'movie' ? '🎬' : '📺';
    return `
<div style="margin-top:18px">
  <div style="font-size:0.82rem;font-weight:600;color:var(--text);margin-bottom:10px">${typeIcon} ${typeLabel} Catalog Sources</div>

  <!-- TMDB Discover -->
  <div style="margin-bottom:10px">
    <div class="section-header" style="margin-bottom:6px"><span style="font-size:0.72rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.08em;font-weight:600">TMDB Discover</span>
      <button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm('${type}')">+ Add</button>
    </div>
    <div class="custom-catalog-form" id="custom-catalog-form-${type}">
      <div class="form-row">
        <div class="field" style="margin-bottom:0"><label>Catalog Name</label><input type="text" id="cc-name-${type}" placeholder="e.g. Sci-Fi Classics"/></div>
        <div class="field" style="margin-bottom:0"><label>Genre</label><select id="cc-genre-${type}"><option value="">Any Genre</option></select></div>
      </div>
      <div class="field" style="margin-top:10px;margin-bottom:0"><label>Sort By</label>
        <select id="cc-sort-${type}">
          <option value="popularity.desc">Most Popular</option>
          <option value="vote_average.desc">Highest Rated</option>
          <option value="release_date.desc">Newest First</option>
          <option value="revenue.desc">Highest Revenue</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="addCustomCatalog('${type}')">Add</button>
        <button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm('${type}')">Cancel</button>
      </div>
    </div>
  </div>

  <!-- MDBList -->
  <div style="margin-bottom:10px">
    <div style="font-size:0.72rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px">MDBList</div>
    <div style="display:flex;gap:8px;margin-bottom:6px">
      <input type="text" id="mdb-cat-url-${type}" placeholder="https://mdblist.com/lists/user/listname/" style="flex:1;font-size:0.83rem"/>
      <button class="btn btn-ghost btn-sm" id="mdb-cat-btn-${type}" onclick="previewMdbCatalog('${type}')" style="white-space:nowrap">Preview</button>
    </div>
    <div id="mdb-cat-status-${type}" style="font-size:0.72rem;color:var(--text-mute);min-height:16px;margin-bottom:4px"></div>
    <div id="mdb-cat-preview-${type}" style="display:none">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px">
        <div class="field" style="margin-bottom:0;flex:1;min-width:140px"><label>Name</label><input type="text" id="mdb-cat-name-${type}" placeholder="Catalog name"/></div>
        <button class="btn btn-primary btn-sm" onclick="addMdbCatalog('${type}')">Add</button>
      </div>
      <div id="mdb-cat-thumbs-${type}" style="display:flex;gap:5px;overflow:hidden;opacity:0.7"></div>
    </div>
  </div>

  <!-- IMDB List -->
  <div style="margin-bottom:10px">
    <div style="font-size:0.72rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px">IMDB List</div>
    <div style="display:flex;gap:8px;margin-bottom:6px">
      <input type="text" id="imdb-cat-url-${type}" placeholder="https://www.imdb.com/list/ls..." style="flex:1;font-size:0.83rem"/>
      <button class="btn btn-ghost btn-sm" id="imdb-cat-btn-${type}" onclick="previewImdbCatalog('${type}')" style="white-space:nowrap">Preview</button>
    </div>
    <div id="imdb-cat-status-${type}" style="font-size:0.72rem;color:var(--text-mute);min-height:16px;margin-bottom:4px"></div>
    <div id="imdb-cat-preview-${type}" style="display:none">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px">
        <div class="field" style="margin-bottom:0;flex:1;min-width:140px"><label>Name</label><input type="text" id="imdb-cat-name-${type}" placeholder="Catalog name"/></div>
        <button class="btn btn-primary btn-sm" onclick="addImdbCatalog('${type}')">Add</button>
      </div>
      <div id="imdb-cat-thumbs-${type}" style="display:flex;gap:5px;overflow:hidden;opacity:0.7"></div>
    </div>
  </div>

  <!-- Handpicked -->
  <div style="margin-bottom:4px">
    <div style="font-size:0.72rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px">Handpicked List</div>
    <div class="field" style="margin-bottom:8px"><input type="text" id="handpicked-name-${type}" placeholder="Catalog name (e.g. My Favorites)"/></div>
    <div style="position:relative">
      <span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-mute);pointer-events:none">&#128269;</span>
      <input type="text" id="handpicked-search-${type}" placeholder="Search for ${typeLabel.toLowerCase()}s to add..." style="padding-left:42px" oninput="debounceHandpickedSearch(this.value,'${type}')"/>
    </div>
    <div class="handpicked-search-results" id="handpicked-results-${type}"></div>
    <div class="handpicked-added" id="handpicked-tags-${type}"></div>
    <button class="btn btn-primary btn-sm mt-1" onclick="addHandpickedCatalog('${type}')">Create Handpicked Catalog</button>
  </div>
</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>GoodTaste — Configure</title>
<style>${css}</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-brand">Good<span>Taste</span></div>
  <div class="topbar-steps">
    <div class="step-pill active" id="step-1"><span class="step-dot"></span><span class="step-label">Connect</span></div>
    <span class="step-divider">&rsaquo;</span>
    <div class="step-pill" id="step-2"><span class="step-dot"></span><span class="step-label">Lists</span></div>
    <span class="step-divider">&rsaquo;</span>
    <div class="step-pill" id="step-3"><span class="step-dot"></span><span class="step-label">Catalogs</span></div>
    <span class="step-divider">&rsaquo;</span>
    <div class="step-pill" id="step-4"><span class="step-dot"></span><span class="step-label">Install</span></div>
  </div>
</div>

<div class="main">

  <!-- PAGE 1: Connect -->
  <div class="page active" id="page-1">
    <div class="hero-wrap">
      <div class="hero-bg">
        <div class="hero-bg-track" id="hero-bg-track"></div>
      </div>
      <div class="hero-bg-overlay"></div>
      <div class="hero-content">
        <div class="hero-logo">Good<span>Taste</span></div>
        <div class="hero-tagline">The ultimate metadata curation addon</div>
        <div class="hero-features">
          <div class="hero-feat"><strong>Full Metadata &amp; Search</strong>Rich posters, ratings, cast, trailers &amp; search — all via TMDB.</div>
          <div class="hero-feat"><strong>Curated Episode Lists</strong>Handpick episodes from any series into a named list you can stream from directly.</div>
          <div class="hero-feat"><strong>Catalog Manager</strong>Create, filter, and manage catalogs from TMDB, MDBList, IMDB, or handpicked titles.</div>
          <div class="hero-feat"><strong>Season Zero <span class="feat-badge">Beta</span></strong>Auto-adds the top-rated episodes of every series as a Season 0.</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-eyebrow">Step 1</div>
      <div class="card-title">Connect to TMDB</div>
      <div class="card-sub">Enter your free TMDB API key to get started. GoodTaste uses TMDB to fetch metadata, search shows, and resolve episodes.</div>
      <div class="field">
        <label>TMDB API Key</label>
        <input type="password" id="apiKey" placeholder="Paste your key here..." autocomplete="off" spellcheck="false" onkeydown="if(event.key==='Enter') validateApiKey()"/>
        <p class="hint">Free key at <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a> — API &rarr; API Key</p>
      </div>
      <button class="btn btn-primary btn-lg" style="width:100%" onclick="validateApiKey()" id="btn-validate">Continue &rarr;</button>
    </div>
  </div>

  <!-- PAGE 2: Curated Lists -->
  <div class="page" id="page-2">
    <div class="card">
      <div class="card-eyebrow">Step 2</div>
      <div class="card-title">Curated Episode Lists</div>
      <div class="card-sub">Search for a TV show and build a curated list of episodes. Each list appears as its own entry in Stremio with a custom name. Streams resolve correctly from custom lists.</div>
      <div class="field search-wrap">
        <span class="search-icon">&#128269;</span>
        <input type="text" id="series-search" placeholder="Search for a TV show..." oninput="debounceSearch(this.value)" autocomplete="off"/>
      </div>
      <div id="search-results" class="search-results"></div>
    </div>

    <div class="card">
      <div class="section-header">
        <span class="section-label">Your Lists</span>
      </div>
      <div id="custom-seasons-list"><div class="empty-state">No shows yet. Search above to get started.</div></div>
    </div>

    <!-- Season Zero (compact) -->
    <div class="szero-card" id="szero-card">
      <div class="szero-header" onclick="toggleSzeroExpand()">
        <div class="szero-header-left">
          <div>
            <div class="szero-title-row"><span class="szero-title">Season Zero</span><span class="beta-badge">Beta</span></div>
            <div class="szero-short-desc">Adds the top-rated episodes of every series as a Season 0</div>
          </div>
        </div>
        <span class="szero-expand" id="szero-expand-btn">Configure &#9660;</span>
      </div>
      <div class="szero-body">
        <p class="szero-full-desc">Automatically adds a "Season Zero" inside every show you open, listing the top-rated episodes ranked by TMDB score. Great for exploring a new series. <strong style="color:var(--text-dim)">Note: streaming from Season Zero may not work on all platforms — use Curated Lists for reliable stream support.</strong></p>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="margin-bottom:0;flex:1;min-width:140px">
            <label>Top N Episodes</label>
            <input type="number" id="topN" placeholder="20" min="5" max="100" value="20"/>
          </div>
          <div class="catalog-row" style="flex:1;min-width:180px;margin-bottom:0">
            <div class="catalog-row-info"><div style="font-size:0.87rem;font-weight:600;color:var(--text)">Enable Season Zero</div><div class="catalog-row-type">Off by default</div></div>
            <label class="toggle"><input type="checkbox" id="showAutoSeason"/><span class="toggle-slider"></span></label>
          </div>
        </div>
      </div>
    </div>

    <div class="nav-row">
      <button class="btn btn-ghost" onclick="goTo(1)">&larr; Back</button>
      <button class="btn btn-primary btn-lg" onclick="goTo(3)">Catalogs &rarr;</button>
    </div>
  </div>

  <!-- PAGE 3: Catalogs -->
  <div class="page" id="page-3">
    <div class="card">
      <div class="card-eyebrow">Step 3</div>
      <div class="card-title">Catalog Manager</div>
      <div class="card-sub">Toggle default catalogs, rename them, or build custom ones from TMDB, MDBList, IMDB, or handpicked titles.</div>

      <!-- Movies section -->
      <div id="cat-section-hdr-movie" class="catalog-section-header" onclick="toggleCatalogSection('movie')">
        <span class="catalog-section-label">Default Movie Catalogs</span>
        <span class="catalog-chevron">&#9660;</span>
      </div>
      <div id="cat-section-body-movie" class="catalog-collapse-body">
        <div id="catalog-defaults-movie"></div>
      </div>

      <!-- Series section -->
      <div id="cat-section-hdr-series" class="catalog-section-header" style="margin-top:8px" onclick="toggleCatalogSection('series')">
        <span class="catalog-section-label">Default Series Catalogs</span>
        <span class="catalog-chevron">&#9660;</span>
      </div>
      <div id="cat-section-body-series" class="catalog-collapse-body">
        <div id="catalog-defaults-series"></div>
      </div>
    </div>

    <!-- Custom catalogs -->
    <div class="card">
      <div class="section-header">
        <div>
          <div style="font-size:0.9rem;font-weight:600;color:#fff">Custom Catalogs</div>
          <div style="font-size:0.78rem;color:var(--text-mute);margin-top:2px">Build catalogs from TMDB Discover, MDBList, IMDB lists, or handpick titles manually</div>
        </div>
      </div>
      <div id="custom-catalogs-list" style="margin-bottom:16px"><div class="empty-state" style="padding:1.5rem 0">No custom catalogs yet.</div></div>

      ${catalogImportSection('movie')}
      <div style="border-top:1px solid var(--border);margin:20px 0"></div>
      ${catalogImportSection('series')}
    </div>

    <div class="nav-row">
      <button class="btn btn-ghost" onclick="goTo(2)">&larr; Back</button>
      <button class="btn btn-primary btn-lg" onclick="goTo(4)">Generate Install Link &rarr;</button>
    </div>
  </div>

  <!-- PAGE 4: Install -->
  <div class="page" id="page-4">
    <div class="card">
      <div class="install-hero">
        <div class="install-hero-title">You have <span>good taste</span></div>
        <div class="install-hero-sub">Add GoodTaste directly to Stremio or copy the manifest URL</div>
      </div>
      <div id="ep-parade" class="ep-parade" style="display:none"></div>
      <div id="install-summary"></div>
      <button class="btn btn-install" onclick="openStremio()">Open in Stremio</button>
      <div class="or-divider">— or copy the manifest URL —</div>
      <div class="copy-row">
        <input type="text" id="manifest-url" readonly/>
        <button class="btn-copy" id="copy-btn" onclick="copyUrl()">Copy</button>
      </div>
    </div>
    <div class="nav-row">
      <button class="btn btn-ghost" onclick="goTo(3)">&larr; Back</button>
    </div>
  </div>

</div>

<!-- Episode picker modal -->
<div class="modal-backdrop" id="modal-backdrop" onclick="closeModalOnBackdrop(event)">
  <div class="modal">
    <div class="modal-header">
      <img class="modal-poster" id="modal-poster" src="" alt=""/>
      <div>
        <div class="modal-title" id="modal-show-name">Loading...</div>
        <div class="modal-sub" id="modal-show-sub"></div>
      </div>
      <div class="modal-close" onclick="closeModal()">&#10005;</div>
    </div>
    <div class="modal-filter" id="modal-season-filters"></div>
    <div class="modal-ep-list" id="modal-ep-list">
      <div class="loading-state"><div class="spinner-light"></div> Loading episodes...</div>
    </div>
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
app.listen(PORT, function() {
  console.log('GoodTaste addon running on port ' + PORT);
  console.log('Configure: http://localhost:' + PORT + '/configure');
});