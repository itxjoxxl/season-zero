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
  { id: 'tmdb.trending_movies',   type: 'movie',  name: 'TMDB Trending Movies',   path: '/trending/movie/week', enabled: true  },
  { id: 'tmdb.popular_movies',    type: 'movie',  name: 'TMDB Popular Movies',     path: '/movie/popular',       enabled: true  },
  { id: 'tmdb.top_rated_movies',  type: 'movie',  name: 'TMDB Top Rated Movies',   path: '/movie/top_rated',     enabled: true  },
  { id: 'tmdb.upcoming_movies',   type: 'movie',  name: 'TMDB Upcoming Movies',    path: '/movie/upcoming',      enabled: false },
  { id: 'tmdb.nowplaying_movies', type: 'movie',  name: 'TMDB Now Playing Movies', path: '/movie/now_playing',   enabled: false },
  { id: 'tmdb.trending_series',   type: 'series', name: 'TMDB Trending Series',    path: '/trending/tv/week',    enabled: true  },
  { id: 'tmdb.popular_series',    type: 'series', name: 'TMDB Popular Series',     path: '/tv/popular',          enabled: true  },
  { id: 'tmdb.top_rated_series',  type: 'series', name: 'TMDB Top Rated Series',   path: '/tv/top_rated',        enabled: true  },
  { id: 'tmdb.airing_today',      type: 'series', name: 'TMDB Airing Today',       path: '/tv/airing_today',     enabled: false },
  { id: 'tmdb.on_the_air',        type: 'series', name: 'TMDB On The Air',         path: '/tv/on_the_air',       enabled: false },
];

// ─── DATA MODEL ──────────────────────────────────────────────────────────────
// customSeasons is an ARRAY of list objects (supports multiple lists per show):
// [
//   {
//     listId:   'abc123',          // stable unique ID (timestamp-based)
//     tmdbId:   '1396',            // TMDB series ID
//     label:    'Essential BB',    // display label (shown in catalog)
//     prefix:   '⭐',              // emoji/text prepended to the show name
//     episodes: [{season, episode}, ...]
//   },
//   ...
// ]
// Each list becomes its own series entry: id = 'bestof:' + listId

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

// Build videos array for a bestof list entry
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

  const customCatalogs = (cfg.customCatalogs || []).filter(c => c.enabled !== false);
  const customSeasons  = cfg.customSeasons || [];  // now an array

  const allCatalogs = [
    ...enabledDefaults.map(d => ({
      id: d.id, type: d.type, name: d.name,
      extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }, { name: 'search', isRequired: false }],
    })),
    ...customCatalogs.map(c => ({
      id: c.id, type: c.type, name: c.name,
      extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }, { name: 'search', isRequired: false }],
    })),
    { id: 'tmdb.search_movies',  type: 'movie',  name: 'TMDB Search Movies',  extra: [{ name: 'search', isRequired: true }] },
    { id: 'tmdb.search_series',  type: 'series', name: 'TMDB Search Series',  extra: [{ name: 'search', isRequired: true }] },
  ];

  // One catalog entry per custom list (supports multiple lists per show)
  if (customSeasons.length > 0) {
    allCatalogs.push({ id: 'tmdb.bestof', type: 'series', name: '\u2b50 Best Of', extra: [] });
  }

  return {
    id:          'community.tmdb-metadata-bestof',
    version:     '4.0.0',
    name:        'TMDB Metadata + Best Of',
    description: 'Full TMDB metadata, catalogs, and search. Custom Best Of lists with IMDB import.',
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

// ─── BEST OF CATALOG ─────────────────────────────────────────────────────────
app.get('/:config/catalog/series/tmdb.bestof.json', async function(req, res) {
  const cfg    = parseConfig(req.params.config);
  const apiKey = cfg.tmdbApiKey;
  if (!apiKey) return res.json({ metas: [] });
  const customSeasons = cfg.customSeasons || [];
  if (!customSeasons.length) return res.json({ metas: [] });
  try {
    // Cache series lookups so we don't hit TMDB multiple times for the same show
    const seriesCache = {};
    const metas = (await Promise.all(customSeasons.map(async function(list) {
      try {
        if (!seriesCache[list.tmdbId]) {
          seriesCache[list.tmdbId] = await getSeries(list.tmdbId, apiKey);
        }
        const series  = seriesCache[list.tmdbId];
        const prefix  = list.prefix || '\u2b50';
        const label   = list.label  || 'Best Of';
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
    const [k, v] = part.split('=');
    if (k && v !== undefined) extrasMap[decodeURIComponent(k)] = decodeURIComponent(v);
  });
  const skip   = parseInt(extrasMap.skip) || 0;
  const page   = Math.floor(skip / 20) + 1;
  const genre  = extrasMap.genre  || null;
  const search = extrasMap.search || null;

  try {
    if (id === 'tmdb.search_movies' || id === 'tmdb.search_series') {
      if (!search) return res.json({ metas: [] });
      const tmdbType = id === 'tmdb.search_movies' ? 'movie' : 'tv';
      const data = await tmdb('/search/' + tmdbType, apiKey, { query: search, page });
      const metas = (data.results || []).map(item =>
        tmdbType === 'movie' ? movieToMeta(item) : seriesToMeta(item)
      ).filter(m => m.poster);
      return res.json({ metas });
    }

    const defaultDef = DEFAULT_CATALOGS.find(d => d.id === id);
    const customDef  = (cfg.customCatalogs || []).find(c => c.id === id);
    const catDef     = defaultDef || customDef;
    if (!catDef) return res.json({ metas: [] });

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

// ─── IMDB LIST IMPORT ─────────────────────────────────────────────────────────
// Fetches the IMDB list CSV export, extracts tvEpisode tt IDs, resolves each
// to {season, episode} via TMDB's /find endpoint, and returns episode refs.
// All episodes must belong to the same TMDB series (tmdbId param).
app.get('/api/imdb-list', async function(req, res) {
  const { url: listUrl, apiKey, tmdbId } = req.query;
  if (!listUrl || !apiKey || !tmdbId) return res.status(400).json({ error: 'url, apiKey, and tmdbId required' });

  // Extract list ID from URL  (ls086682535)
  const listIdMatch = listUrl.match(/ls\d+/);
  if (!listIdMatch) return res.status(400).json({ error: 'Could not parse IMDB list ID from URL' });
  const listId = listIdMatch[0];

  try {
    // Fetch CSV export - IMDB provides this publicly
    const csvUrl = 'https://www.imdb.com/list/' + listId + '/export';
    let csvText;
    try {
      const resp = await axios.get(csvUrl, {
        headers: { 'Accept': 'text/csv,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        timeout: 15000,
      });
      csvText = resp.data;
    } catch (e) {
      // CSV export may require login for some lists — fall back to scraping list page
      const pageUrl = 'https://www.imdb.com/list/' + listId + '/';
      const resp = await axios.get(pageUrl, {
        headers: { 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html' },
        timeout: 15000,
      });
      // Extract tt IDs from href="/title/ttXXXXXXX/" patterns in HTML
      const ttMatches = [...resp.data.matchAll(/\/title\/(tt\d+)\//g)].map(m => m[1]);
      const unique = [...new Set(ttMatches)];
      csvText = null;  // signal to use ttIds directly
      req._ttIds = unique;
    }

    let ttIds = [];
    if (csvText) {
      // Parse CSV: find header row, locate 'Const' and 'Title Type' columns
      const lines = csvText.split('\n').filter(l => l.trim());
      const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
      const constIdx = header.findIndex(h => h === 'const');
      const typeIdx  = header.findIndex(h => h === 'title type');
      if (constIdx === -1) return res.status(400).json({ error: 'Unexpected CSV format — missing Const column' });
      for (let i = 1; i < lines.length; i++) {
        // Simple CSV parse (handles quoted fields)
        const cols = lines[i].match(/("([^"]*)"|([^,]*))(,|$)/g)
          .map(f => f.replace(/^"|"$|,$/g, '').trim());
        const ttId  = cols[constIdx];
        const ttypeRaw = typeIdx !== -1 ? (cols[typeIdx] || '') : '';
        // IMDb exports sometimes use "TV Episode" (with a space) rather than "tvEpisode".
        // Normalize aggressively so we don't accidentally filter out all episodes.
        const ttype = String(ttypeRaw).toLowerCase().replace(/[^a-z0-9]/g, '');
        // Accept TV episode rows, OR if no type column just accept all tt IDs
        if (ttId && ttId.startsWith('tt') && (typeIdx === -1 || ttype === 'tvepisode')) {
          ttIds.push(ttId);
        }
      }
    } else {
      ttIds = req._ttIds || [];
    }

    if (!ttIds.length) return res.json({ episodes: [], errors: [], skipped: 0 });

    // Resolve each tt ID to season/episode via TMDB /find
    const results = [];
    const errors  = [];
    // Batch sequentially to avoid rate limiting
    for (const ttId of ttIds) {
      try {
        const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' });
        const epResults = found.tv_episode_results || [];
        if (epResults.length > 0) {
          const ep = epResults[0];
          // Verify it belongs to the requested show
          if (String(ep.show_id) === String(tmdbId)) {
            results.push({ season: ep.season_number, episode: ep.episode_number });
          } else {
            errors.push({ ttId, reason: 'Episode belongs to a different show (show_id=' + ep.show_id + ')' });
          }
        } else {
          errors.push({ ttId, reason: 'Not found as TV episode on TMDB' });
        }
      } catch (e) {
        errors.push({ ttId, reason: e.message });
      }
    }

    // Deduplicate
    const seen = new Set();
    const deduped = results.filter(ep => {
      const key = ep.season + ':' + ep.episode;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ episodes: deduped, errors, skipped: errors.length });
  } catch (e) {
    console.error('[imdb-list]', e.message);
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
      poster: movie.poster_path ? TMDB_IMG_MD + movie.poster_path : null,
      background: movie.backdrop_path ? TMDB_IMG_LG + movie.backdrop_path : null,
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
});

app.get('/:config/meta/series/:id.json', async function(req, res) {
  const cfg = parseConfig(req.params.config);
  const id  = req.params.id;
  if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });

  // ── bestof: handler ───────────────────────────────────────────────────────
  // Stremio URL-encodes the colon as %3A in the path, so a dedicated route
  // like app.get('...bestof\\::id...') never matches (Express matches raw paths).
  // The generic :id param receives the already-decoded value 'bestof:xxxx'.
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
      const prefix      = list.prefix || '\u2b50';
      const label       = list.label  || 'Best Of';
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

  // ── regular tmdb: series ──────────────────────────────────────────────────
  if (!id.startsWith('tmdb:')) return res.json({ meta: null });
  const tmdbId = extractId(id);
  const topN   = parseInt(cfg.topN) || 20;
  try {
    const series = await getSeries(tmdbId, cfg.tmdbApiKey);
    const cert   = getSeriesCert(series);
    const cast   = (series.credits && series.credits.cast || []).slice(0, 8).map(c => c.name);
    const videos = [];

    for (let s = 1; s <= (series.number_of_seasons || 0); s++) {
      try {
        const season = await getSeason(tmdbId, s, cfg.tmdbApiKey);
        for (const ep of (season.episodes || [])) {
          videos.push({
            id: id + ':' + s + ':' + ep.episode_number,
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
          id: id + ':0:' + rank,
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
      links: series.external_ids && series.external_ids.imdb_id
        ? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' + series.external_ids.imdb_id }] : [],
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
  // Only handle Season 0 auto-best-of via tmdb: prefix
  if (parts[0] !== 'tmdb' || parts.length < 4) return res.json({ videos: [] });
  const tmdbId     = parts[1];
  const season     = parseInt(parts[2]);
  const episodeNum = parseInt(parts[3]);
  if (season !== 0) return res.json({ videos: [] });
  try {
    const series = await getSeries(tmdbId, cfg.tmdbApiKey);
    const topN   = parseInt(cfg.topN) || 20;
    const topEps = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN);
    const target = topEps[episodeNum - 1];
    if (!target) return res.json({ videos: [] });
    res.json({ videos: [{
      id:        'tmdb:' + tmdbId + ':' + target.season + ':' + target.episode,
      title:     target.name, season: target.season, episode: target.episode,
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
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #080b10; --surface: #0e1219; --surface2: #131820;
      --border: #1e2530; --border2: #2a3340;
      --text: #c8d4e0; --text-dim: #5a6878; --text-mute: #3a4555;
      --accent: #3d9be9; --accent2: #56cfb0; --gold: #f0b429;
      --purple: #8b5cf6; --danger: #e05252; --radius: 12px;
    }
    body { background: var(--bg); color: var(--text); font-family: "DM Sans", sans-serif; min-height: 100vh; }
    .app { display: flex; flex-direction: column; min-height: 100vh; }
    .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 2rem; height: 60px; display: flex; align-items: center; gap: 1rem; position: sticky; top: 0; z-index: 100; }
    .topbar-logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 1rem; color: #fff; }
    .topbar-steps { display: flex; align-items: center; gap: 0; margin-left: auto; }
    .step-item { display: flex; align-items: center; gap: 8px; font-size: 0.78rem; color: var(--text-dim); padding: 6px 14px; }
    .step-item.active { color: var(--accent); }
    .step-item.done { color: var(--accent2); }
    .step-num { width: 22px; height: 22px; border-radius: 50%; background: var(--surface2); border: 1.5px solid var(--border2); display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700; }
    .step-item.active .step-num { background: var(--accent); border-color: var(--accent); color: #fff; }
    .step-item.done .step-num { background: var(--accent2); border-color: var(--accent2); color: #000; }
    .step-divider { color: var(--text-mute); font-size: 0.7rem; }
    .main { flex: 1; padding: 2.5rem 2rem; max-width: 820px; margin: 0 auto; width: 100%; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 2rem 2rem 2.2rem; margin-bottom: 1.4rem; }
    .card-title { font-size: 1rem; font-weight: 700; color: #fff; margin-bottom: 0.25rem; }
    .card-sub { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 1.5rem; }
    .field { margin-bottom: 1.2rem; }
    label { display: block; font-size: 0.78rem; font-weight: 600; color: var(--text-dim); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    input[type=text], input[type=number], input[type=password] { width: 100%; background: var(--bg); border: 1.5px solid var(--border2); border-radius: var(--radius); padding: 11px 14px; color: var(--text); font-size: 0.93rem; font-family: inherit; outline: none; transition: border-color 0.15s; }
    select { width: 100%; background: var(--bg); border: 1.5px solid var(--border2); border-radius: var(--radius); padding: 11px 14px; color: var(--text); font-size: 0.93rem; font-family: inherit; outline: none; transition: border-color 0.15s; cursor: pointer; }
    input:focus, select:focus { border-color: var(--accent); }
    input.error { border-color: var(--danger) !important; animation: shake 0.3s; }
    @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
    .hint { font-size: 0.72rem; color: var(--text-mute); margin-top: 5px; }
    .hint a { color: var(--accent); text-decoration: none; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 10px 20px; border-radius: var(--radius); font-size: 0.88rem; font-weight: 600; font-family: inherit; cursor: pointer; border: none; transition: all 0.15s; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { opacity: 0.85; }
    .btn-secondary { background: var(--surface2); border: 1.5px solid var(--border2); color: var(--text); }
    .btn-secondary:hover { border-color: var(--accent); color: var(--accent); }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-danger:hover { opacity: 0.85; }
    .btn-gold { background: var(--gold); color: #000; }
    .btn-gold:hover { opacity: 0.85; }
    .btn-install { background: var(--purple); color: #fff; width: 100%; font-size: 1rem; padding: 14px; border-radius: var(--radius); }
    .btn-install:hover { opacity: 0.85; }
    .btn-lg { padding: 13px 28px; font-size: 0.95rem; }
    .btn-sm { padding: 6px 12px; font-size: 0.75rem; }
    .page { display: none; }
    .page.active { display: block; }
    .features-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 1.8rem; }
    .feature-chip { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 0.8rem; color: var(--text-dim); display: flex; align-items: center; gap: 8px; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.2rem; }
    .section-title { font-size: 0.82rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; }
    .search-wrap { position: relative; }
    .search-wrap input { padding-left: 42px; }
    .search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--text-mute); pointer-events: none; }
    .search-results { margin-top: 10px; display: none; }
    .search-results.visible { display: block; }
    .search-result-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; cursor: pointer; transition: background 0.12s; border: 1px solid transparent; }
    .search-result-item:hover { background: var(--surface2); border-color: var(--border); }
    .search-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }
    .search-name { font-size: 0.88rem; font-weight: 600; color: var(--text); }
    .search-meta { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }
    .custom-seasons-empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-mute); font-size: 0.83rem; }
    .list-card { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; margin-bottom: 12px; background: var(--surface2); }
    .list-card-header { display: flex; align-items: center; gap: 14px; padding: 14px 16px; cursor: pointer; transition: background 0.12s; }
    .list-card-header:hover { background: var(--bg); }
    .list-poster { width: 32px; height: 48px; border-radius: 5px; object-fit: cover; background: var(--surface); flex-shrink: 0; }
    .list-card-meta { flex: 1; min-width: 0; }
    .list-card-name { font-size: 0.9rem; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .list-card-sub { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }
    .list-card-count { font-size: 0.72rem; color: var(--text-dim); flex-shrink: 0; }
    .list-card-chevron { color: var(--text-mute); transition: transform 0.2s; font-size: 0.8rem; }
    .list-card.open .list-card-chevron { transform: rotate(90deg); }
    .list-card-body { display: none; border-top: 1px solid var(--border); padding: 14px 16px; }
    .list-card.open .list-card-body { display: block; }
    .list-meta-row { display: flex; gap: 8px; margin-bottom: 12px; align-items: flex-end; }
    .list-meta-row .field { margin-bottom: 0; flex: 1; }
    .prefix-field { max-width: 90px; }
    .ep-list { list-style: none; min-height: 40px; }
    .ep-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; margin-bottom: 5px; background: var(--surface); border: 1px solid var(--border); cursor: grab; user-select: none; }
    .ep-item.dragging { opacity: 0.45; background: var(--bg); }
    .ep-item.drag-over { border-color: var(--accent); }
    .ep-rank { width: 22px; text-align: center; flex-shrink: 0; font-size: 0.72rem; color: var(--text-mute); font-family: "DM Mono", monospace; }
    .ep-drag { color: var(--text-mute); flex-shrink: 0; }
    .ep-thumb { width: 56px; height: 32px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: var(--bg); }
    .ep-info { flex: 1; min-width: 0; }
    .ep-label { font-size: 0.8rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ep-sublabel { font-size: 0.68rem; color: var(--text-dim); margin-top: 2px; }
    .ep-rating { font-size: 0.72rem; color: var(--gold); font-family: "DM Mono", monospace; flex-shrink: 0; }
    .ep-del { flex-shrink: 0; color: var(--text-mute); cursor: pointer; font-size: 1rem; padding: 4px; border-radius: 5px; transition: color 0.12s; }
    .ep-del:hover { color: var(--danger); }
    .ep-list-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .imdb-import-row { display: flex; gap: 8px; margin-top: 10px; }
    .imdb-import-row input { flex: 1; font-size: 0.82rem; }
    .imdb-import-status { font-size: 0.75rem; margin-top: 6px; color: var(--text-dim); min-height: 18px; }
    .imdb-import-status.ok  { color: var(--accent2); }
    .imdb-import-status.err { color: var(--danger); }
    .catalog-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 8px; }
    .catalog-row-info { flex: 1; }
    .catalog-row-name { font-size: 0.86rem; font-weight: 600; color: var(--text); }
    .catalog-row-type { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; }
    .toggle { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; inset: 0; background: var(--border2); border-radius: 22px; transition: background 0.2s; cursor: pointer; }
    .toggle-slider::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform 0.2s; }
    .toggle input:checked + .toggle-slider { background: var(--accent); }
    .toggle input:checked + .toggle-slider::before { transform: translateX(16px); }
    .catalog-section-label { font-size: 0.72rem; font-weight: 700; color: var(--text-mute); text-transform: uppercase; letter-spacing: 0.08em; margin: 16px 0 8px; }
    .custom-catalog-form { background: var(--surface2); border: 1px solid var(--border2); border-radius: 14px; padding: 16px; margin-top: 14px; display: none; }
    .custom-catalog-form.open { display: block; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .custom-catalog-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 8px; }
    .custom-catalog-item-info { flex: 1; }
    .custom-catalog-item-name { font-size: 0.86rem; font-weight: 600; color: var(--text); }
    .custom-catalog-item-sub { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; font-family: "DM Mono", monospace; }
    .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 500; align-items: center; justify-content: center; padding: 1.5rem; }
    .modal-backdrop.open { display: flex; }
    .modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 20px; max-width: 580px; width: 100%; max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; }
    .modal-header { padding: 1.4rem 1.6rem 1rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 14px; }
    .modal-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }
    .modal-title { font-size: 1rem; font-weight: 700; color: #fff; }
    .modal-sub { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }
    .modal-close { margin-left: auto; color: var(--text-mute); cursor: pointer; font-size: 1.3rem; }
    .modal-close:hover { color: var(--text); }
    .modal-filter { padding: 12px 1.6rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .season-filter-btn { padding: 5px 13px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; background: var(--surface2); border: 1.5px solid var(--border); color: var(--text-dim); cursor: pointer; transition: all 0.12s; }
    .season-filter-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
    .modal-ep-list { flex: 1; overflow-y: auto; padding: 10px 1.6rem; }
    .modal-ep-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; margin-bottom: 4px; cursor: pointer; transition: background 0.1s; border: 1.5px solid transparent; }
    .modal-ep-item:hover { background: var(--surface2); }
    .modal-ep-item.selected { border-color: var(--accent); }
    .modal-ep-thumb { width: 64px; height: 36px; border-radius: 5px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }
    .modal-ep-info { flex: 1; min-width: 0; }
    .modal-ep-name { font-size: 0.82rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .modal-ep-meta { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; }
    .modal-ep-check { width: 20px; height: 20px; border-radius: 6px; border: 2px solid var(--border2); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; transition: all 0.12s; }
    .modal-ep-item.selected .modal-ep-check { background: var(--accent); border-color: var(--accent); color: #fff; }
    .modal-footer { padding: 1rem 1.6rem; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .modal-selected-count { font-size: 0.8rem; color: var(--text-dim); }
    .generate-hero { text-align: center; padding: 1.2rem 0 2rem; }
    .generate-hero h2 { font-size: 1.3rem; font-weight: 700; color: #fff; margin-bottom: 6px; }
    .generate-hero p { font-size: 0.83rem; color: var(--text-dim); }
    .summary-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 8px; font-size: 0.82rem; }
    .summary-label { color: var(--text-dim); }
    .summary-value { color: #fff; font-weight: 600; font-family: "DM Mono", monospace; font-size: 0.78rem; }
    .summary-value.accent { color: var(--accent); }
    .summary-value.gold { color: var(--gold); }
    .or-line { text-align: center; font-size: 0.72rem; color: var(--text-mute); margin: 14px 0 12px; }
    .copy-row { display: flex; gap: 8px; }
    .copy-row input { flex: 1; font-size: 0.73rem; color: var(--text-dim); padding: 9px 12px; font-family: "DM Mono", monospace; }
    .btn-copy { flex-shrink: 0; padding: 9px 16px; background: var(--surface2); border: 1.5px solid var(--border2); border-radius: var(--radius); color: var(--text-dim); font-size: 0.78rem; font-weight: 600; cursor: pointer; transition: all 0.15s; font-family: inherit; }
    .btn-copy:hover { border-color: var(--accent); color: var(--accent); }
    .btn-copy.copied { border-color: var(--accent2); color: var(--accent2); }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.2); border-top-color: rgba(255,255,255,0.8); border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-overlay { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 2rem; font-size: 0.83rem; color: var(--text-dim); }
    .nav-row { display: flex; justify-content: space-between; align-items: center; margin-top: 1.4rem; }
    @media (max-width: 540px) { .features-grid { grid-template-columns: 1fr; } .main { padding: 1.5rem 1rem; } .form-row { grid-template-columns: 1fr; } .list-meta-row { flex-wrap: wrap; } }
  `;

  // ── Client JS ──────────────────────────────────────────────────────────────
  // state.customSeasons is now an ARRAY of list objects matching the server model:
  // [{ listId, tmdbId, tmdbName, tmdbPoster, label, prefix, episodes:[{season,episode,name,still,...}] }]
  const clientJS = [
    "var DEFAULT_CATALOGS = " + defaultCatalogsJson + ";",
    // customSeasons is now an array of list objects
    "var state = { apiKey: '', topN: 20, showAutoSeason: true, customSeasons: [], catalogEnabled: {}, customCatalogs: [] };",
    "var modalData = { listId: null, tmdbId: null, tmdbName: null, tmdbPoster: null, allEpisodes: [], filteredSeason: 'all', selected: new Set() };",
    "var genreCache = { movie: null, tv: null };",
    "",
    "function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }",
    "",
    "function goTo(n) {",
    "  document.querySelectorAll('.page').forEach(function(p, i) { p.classList.toggle('active', i + 1 === n); });",
    "  document.querySelectorAll('[id^=step-tab-]').forEach(function(el, i) {",
    "    var num = i + 1; el.classList.remove('active', 'done');",
    "    if (num === n) el.classList.add('active');",
    "    else if (num < n) el.classList.add('done');",
    "  });",
    "  if (n === 4) buildInstallPage();",
    "  window.scrollTo({ top: 0, behavior: 'smooth' });",
    "}",
    "",
    "async function validateApiKey() {",
    "  var input = document.getElementById('apiKey');",
    "  var key = input.value.trim();",
    "  var btn = document.getElementById('btn-validate');",
    "  if (!key) { flashError(input); return; }",
    "  btn.innerHTML = '<span class=\"spinner\"></span> Validating...';",
    "  btn.disabled = true;",
    "  try {",
    "    var r = await fetch('/api/search?q=test&apiKey=' + encodeURIComponent(key));",
    "    var d = await r.json();",
    "    if (d.error) throw new Error(d.error);",
    "    state.apiKey = key;",
    "    state.topN = parseInt(document.getElementById('topN').value) || 20;",
    "    state.showAutoSeason = document.getElementById('showAutoSeason').checked;",
    "    renderDefaultCatalogs();",
    "    goTo(2);",
    "  } catch(e) {",
    "    flashError(input); input.placeholder = 'Invalid API key \u2014 try again';",
    "  } finally { btn.innerHTML = 'Continue &rarr;'; btn.disabled = false; }",
    "}",
    "",
    "function flashError(el) { el.classList.add('error'); el.focus(); setTimeout(function() { el.classList.remove('error'); }, 2000); }",
    "",
    // ── Catalog UI ──────────────────────────────────────────────────────────
    "function renderDefaultCatalogs() {",
    "  ['movie', 'series'].forEach(function(type) {",
    "    var el = document.getElementById('catalog-defaults-' + type);",
    "    var cats = DEFAULT_CATALOGS.filter(function(c) { return c.type === type; });",
    "    el.innerHTML = cats.map(function(c) {",
    "      var checked = state.catalogEnabled[c.id] !== undefined ? state.catalogEnabled[c.id] : c.enabled;",
    "      return '<div class=\"catalog-row\"><div class=\"catalog-row-info\"><div class=\"catalog-row-name\">' + esc(c.name) + '</div><div class=\"catalog-row-type\">' + c.type + '</div></div><label class=\"toggle\"><input type=\"checkbox\" ' + (checked ? 'checked' : '') + ' onchange=\"setCatalogEnabled(\\'' + c.id + '\\',this.checked)\"/><span class=\"toggle-slider\"></span></label></div>';",
    "    }).join('');",
    "  });",
    "}",
    "function setCatalogEnabled(id, val) { state.catalogEnabled[id] = val; }",
    "",
    "function toggleCustomCatalogForm() {",
    "  var form = document.getElementById('custom-catalog-form');",
    "  form.classList.toggle('open');",
    "  if (form.classList.contains('open')) loadGenresForCustom();",
    "}",
    "async function loadGenresForCustom() {",
    "  var type = document.getElementById('cc-type').value;",
    "  var tmdbType = type === 'series' ? 'tv' : 'movie';",
    "  if (genreCache[tmdbType]) { populateGenreSelect(genreCache[tmdbType]); return; }",
    "  try {",
    "    var r = await fetch('/api/genres?apiKey=' + encodeURIComponent(state.apiKey) + '&type=' + tmdbType);",
    "    var d = await r.json();",
    "    genreCache[tmdbType] = d.genres || [];",
    "    populateGenreSelect(genreCache[tmdbType]);",
    "  } catch(e) {}",
    "}",
    "function populateGenreSelect(genres) {",
    "  var sel = document.getElementById('cc-genre');",
    "  sel.innerHTML = '<option value=\"\">Any Genre</option>' + genres.map(function(g) { return '<option value=\"' + g.id + '\">' + esc(g.name) + '</option>'; }).join('');",
    "}",
    "function addCustomCatalog() {",
    "  var name = document.getElementById('cc-name').value.trim();",
    "  var type = document.getElementById('cc-type').value;",
    "  var genre = document.getElementById('cc-genre').value;",
    "  var sort = document.getElementById('cc-sort').value;",
    "  if (!name) { var n = document.getElementById('cc-name'); n.classList.add('error'); setTimeout(function(){ n.classList.remove('error'); }, 1500); return; }",
    "  var tmdbType = type === 'series' ? 'tv' : 'movie';",
    "  var params = { sort_by: sort };",
    "  if (genre) params.with_genres = genre;",
    "  state.customCatalogs.push({ id: 'custom.' + Date.now(), name: name, type: type, path: '/discover/' + tmdbType, params: params, enabled: true });",
    "  document.getElementById('cc-name').value = ''; document.getElementById('cc-genre').value = ''; document.getElementById('cc-sort').value = 'popularity.desc';",
    "  document.getElementById('custom-catalog-form').classList.remove('open');",
    "  renderCustomCatalogsList();",
    "}",
    "function removeCustomCatalog(id) { state.customCatalogs = state.customCatalogs.filter(function(c) { return c.id !== id; }); renderCustomCatalogsList(); }",
    "function renderCustomCatalogsList() {",
    "  var el = document.getElementById('custom-catalogs-list');",
    "  if (!state.customCatalogs.length) { el.innerHTML = '<div class=\"custom-seasons-empty\">No custom catalogs yet.</div>'; return; }",
    "  var sortLabels = { 'popularity.desc': 'Popular', 'vote_average.desc': 'Top Rated', 'release_date.desc': 'Newest', 'revenue.desc': 'Revenue' };",
    "  el.innerHTML = state.customCatalogs.map(function(c) {",
    "    var sortLabel = (c.params && sortLabels[c.params.sort_by]) || '';",
    "    var genrePart = c.params && c.params.with_genres ? ' \u00b7 Genre ' + c.params.with_genres : '';",
    "    return '<div class=\"custom-catalog-item\"><div class=\"custom-catalog-item-info\"><div class=\"custom-catalog-item-name\">' + esc(c.name) + '</div><div class=\"custom-catalog-item-sub\">' + c.type + ' \u00b7 ' + sortLabel + genrePart + '</div></div><button class=\"btn btn-danger btn-sm\" onclick=\"removeCustomCatalog(\\'' + c.id + '\\')\">Remove</button></div>';",
    "  }).join('');",
    "}",
    "",
    // ── Show search ─────────────────────────────────────────────────────────
    "var searchTimer;",
    "function debounceSearch(q) {",
    "  clearTimeout(searchTimer);",
    "  if (!q.trim()) { document.getElementById('search-results').classList.remove('visible'); return; }",
    "  searchTimer = setTimeout(function() { doSearch(q); }, 350);",
    "}",
    "async function doSearch(q) {",
    "  var box = document.getElementById('search-results');",
    "  box.classList.add('visible');",
    "  box.innerHTML = '<div class=\"loading-overlay\"><div class=\"spinner\"></div> Searching...</div>';",
    "  try {",
    "    var r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&apiKey=' + encodeURIComponent(state.apiKey) + '&type=tv');",
    "    var d = await r.json();",
    "    if (!d.results || !d.results.length) { box.innerHTML = '<p style=\"padding:1rem;font-size:0.82rem;color:var(--text-mute)\">No results found.</p>'; return; }",
    "    box.innerHTML = d.results.map(function(s) {",
    "      var ph = s.poster ? '<img class=\"search-poster\" src=\"' + s.poster + '\" alt=\"\" loading=\"lazy\"/>' : '<div class=\"search-poster\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#128250;</div>';",
    // Clicking a search result creates a new list for that show
    "      return '<div class=\"search-result-item\" onclick=\"createNewList(' + s.id + ',\\'' + esc4attr(s.name) + '\\',\\'' + esc4attr(s.poster || '') + '\\')\">'+ph+'<div><div class=\"search-name\">' + esc(s.name) + '</div><div class=\"search-meta\">' + (s.year ? s.year + ' &middot; ' : '') + '&#11088; ' + s.vote_average + '</div></div></div>';",
    "    }).join('');",
    "  } catch(e) { box.innerHTML = '<p style=\"padding:1rem;color:var(--text-mute)\">Error searching.</p>'; }",
    "}",
    "",
    // ── Create / manage lists ────────────────────────────────────────────────
    // createNewList: adds a new empty list for the show and opens episode picker
    "function createNewList(tmdbId, name, poster) {",
    "  var listId = uid();",
    "  state.customSeasons.push({ listId: listId, tmdbId: String(tmdbId), tmdbName: name, tmdbPoster: poster, label: 'Best Of', prefix: '\u2b50', episodes: [] });",
    "  document.getElementById('search-results').classList.remove('visible');",
    "  document.getElementById('series-search').value = '';",
    "  renderCustomSeasonsList();",
    // Auto-open the new list card so user sees it, and open episode picker
    "  setTimeout(function() {",
    "    var card = document.getElementById('card-' + listId);",
    "    if (card) card.classList.add('open');",
    "    openModal(listId);",
    "  }, 50);",
    "}",
    "",
    "function getList(listId) { return state.customSeasons.find(function(l) { return l.listId === listId; }); }",
    "",
    "function updateListMeta(listId, field, value) {",
    "  var list = getList(listId);",
    "  if (list) { list[field] = value; }",
    // Re-render just the header name to reflect changes live
    "  var nameEl = document.getElementById('list-name-' + listId);",
    "  if (nameEl && list) nameEl.textContent = (list.prefix || '\u2b50') + ' ' + (list.label || 'Best Of') + ' \u2014 ' + list.tmdbName;",
    "}",
    "",
    "function removeList(listId) {",
    "  state.customSeasons = state.customSeasons.filter(function(l) { return l.listId !== listId; });",
    "  renderCustomSeasonsList();",
    "}",
    "function removeEp(listId, idx) {",
    "  var list = getList(listId);",
    "  if (!list) return;",
    "  list.episodes.splice(idx, 1);",
    "  renderCustomSeasonsList();",
    "}",
    "function toggleCard(listId) { document.getElementById('card-' + listId).classList.toggle('open'); }",
    "",
    // ── Episode picker modal ─────────────────────────────────────────────────
    "async function openModal(listId) {",
    "  var list = getList(listId);",
    "  if (!list) return;",
    "  modalData.listId    = listId;",
    "  modalData.tmdbId    = list.tmdbId;",
    "  modalData.tmdbName  = list.tmdbName;",
    "  modalData.tmdbPoster = list.tmdbPoster;",
    "  modalData.allEpisodes = []; modalData.filteredSeason = 'all';",
    "  modalData.selected = new Set(list.episodes.map(function(e) { return e.season + ':' + e.episode; }));",
    "  document.getElementById('modal-show-name').textContent = list.tmdbName;",
    "  document.getElementById('modal-show-sub').textContent = 'Loading...';",
    "  document.getElementById('modal-poster').src = list.tmdbPoster || '';",
    "  document.getElementById('modal-season-filters').innerHTML = '';",
    "  document.getElementById('modal-ep-list').innerHTML = '<div class=\"loading-overlay\"><div class=\"spinner\"></div> Loading episodes...</div>';",
    "  updateModalCount();",
    "  document.getElementById('modal-backdrop').classList.add('open');",
    "  document.body.style.overflow = 'hidden';",
    "  try {",
    "    var r = await fetch('/api/episodes?tmdbId=' + list.tmdbId + '&apiKey=' + encodeURIComponent(state.apiKey));",
    "    var d = await r.json();",
    "    if (d.error) throw new Error(d.error);",
    "    modalData.allEpisodes = d.episodes;",
    "    document.getElementById('modal-show-sub').textContent = d.show.seasons + ' season' + (d.show.seasons !== 1 ? 's' : '') + ' \u2014 ' + d.episodes.length + ' episodes';",
    "    var seasons = []; d.episodes.forEach(function(e) { if (seasons.indexOf(e.season) === -1) seasons.push(e.season); }); seasons.sort(function(a,b){return a-b;});",
    "    var filters = document.getElementById('modal-season-filters');",
    "    var btns = ['<button class=\"season-filter-btn active\" onclick=\"setSeasonFilter(\\'all\\',this)\">All</button>'];",
    "    seasons.forEach(function(s) { btns.push('<button class=\"season-filter-btn\" onclick=\"setSeasonFilter(' + s + ',this)\">S' + s + '</button>'); });",
    "    filters.innerHTML = btns.join('');",
    "    renderModalEpisodes();",
    "  } catch(e) {",
    "    document.getElementById('modal-ep-list').innerHTML = '<p style=\"padding:1rem;color:var(--text-mute)\">Error: ' + esc(e.message) + '</p>';",
    "  }",
    "}",
    "function setSeasonFilter(val, btn) {",
    "  modalData.filteredSeason = val;",
    "  document.querySelectorAll('.season-filter-btn').forEach(function(b) { b.classList.remove('active'); });",
    "  btn.classList.add('active');",
    "  renderModalEpisodes();",
    "}",
    "function renderModalEpisodes() {",
    "  var eps = modalData.filteredSeason === 'all' ? modalData.allEpisodes : modalData.allEpisodes.filter(function(e) { return e.season === modalData.filteredSeason; });",
    "  var list = document.getElementById('modal-ep-list');",
    "  if (!eps.length) { list.innerHTML = '<p style=\"padding:1rem;color:var(--text-mute)\">No episodes.</p>'; return; }",
    "  list.innerHTML = eps.map(function(ep) {",
    "    var key = ep.season + ':' + ep.episode;",
    "    var sel = modalData.selected.has(key);",
    "    var sL = String(ep.season).padStart(2,'0'); var eL = String(ep.episode).padStart(2,'0');",
    "    var th = ep.still ? '<img class=\"modal-ep-thumb\" src=\"' + ep.still + '\" alt=\"\" loading=\"lazy\"/>' : '<div class=\"modal-ep-thumb\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#127902;</div>';",
    "    return '<div class=\"modal-ep-item' + (sel ? ' selected' : '') + '\" onclick=\"toggleEp(\\'' + key + '\\',this)\">' + th + '<div class=\"modal-ep-info\"><div class=\"modal-ep-name\">S' + sL + 'E' + eL + ' \u2014 ' + esc(ep.name) + '</div><div class=\"modal-ep-meta\">' + (ep.vote_average > 0 ? '&#11088; ' + ep.vote_average.toFixed(1) + ' &middot; ' : '') + (ep.air_date || '') + '</div></div><div class=\"modal-ep-check\">' + (sel ? '&#10003;' : '') + '</div></div>';",
    "  }).join('');",
    "}",
    "function toggleEp(key, el) {",
    "  if (modalData.selected.has(key)) { modalData.selected.delete(key); el.classList.remove('selected'); el.querySelector('.modal-ep-check').innerHTML = ''; }",
    "  else { modalData.selected.add(key); el.classList.add('selected'); el.querySelector('.modal-ep-check').innerHTML = '&#10003;'; }",
    "  updateModalCount();",
    "}",
    "function updateModalCount() { document.getElementById('modal-sel-count').textContent = modalData.selected.size; }",
    "function addSelectedEpisodes() {",
    "  var list = getList(modalData.listId);",
    "  if (!list) { closeModal(); return; }",
    "  var keys = Array.from(modalData.selected);",
    "  var episodes = keys.map(function(k) {",
    "    var p = k.split(':').map(Number);",
    "    return modalData.allEpisodes.find(function(ep) { return ep.season === p[0] && ep.episode === p[1]; });",
    "  }).filter(Boolean);",
    // Preserve existing order for already-selected eps, append new ones at end
    "  var existingKeys = new Set(list.episodes.map(function(e) { return e.season + ':' + e.episode; }));",
    "  var kept = list.episodes.filter(function(e) { return keys.indexOf(e.season + ':' + e.episode) !== -1; });",
    "  var newEps = episodes.filter(function(e) { return !existingKeys.has(e.season + ':' + e.episode); });",
    "  list.episodes = kept.concat(newEps);",
    "  closeModal();",
    "  renderCustomSeasonsList();",
    "}",
    "function closeModal() { document.getElementById('modal-backdrop').classList.remove('open'); document.body.style.overflow = ''; }",
    "function closeModalOnBackdrop(e) { if (e.target === document.getElementById('modal-backdrop')) closeModal(); }",
    "",
    // ── IMDB import ─────────────────────────────────────────────────────────
    "async function importImdbList(listId) {",
    "  var list = getList(listId);",
    "  if (!list) return;",
    "  var input  = document.getElementById('imdb-url-' + listId);",
    "  var status = document.getElementById('imdb-status-' + listId);",
    "  var btn    = document.getElementById('imdb-btn-' + listId);",
    "  var url    = (input ? input.value : '').trim();",
    "  if (!url) { if (status) { status.textContent = 'Please enter an IMDB list URL'; status.className = 'imdb-import-status err'; } return; }",
    "  if (btn) { btn.disabled = true; btn.innerHTML = '<span class=\"spinner\"></span>'; }",
    "  if (status) { status.textContent = 'Fetching list\u2026'; status.className = 'imdb-import-status'; }",
    "  try {",
    "    var r = await fetch('/api/imdb-list?url=' + encodeURIComponent(url) + '&apiKey=' + encodeURIComponent(state.apiKey) + '&tmdbId=' + list.tmdbId);",
    "    var d = await r.json();",
    "    if (d.error) throw new Error(d.error);",
    "    if (!d.episodes || !d.episodes.length) {",
    "      var hint = '';",
    "      if (d.errors && d.errors.length) {",
    "        hint = ' Example: ' + (d.errors[0].ttId || '') + (d.errors[0].reason ? ' — ' + d.errors[0].reason : '');",
    "      }",
    "      throw new Error('No matching episodes found for this show. Make sure your IMDb list items are TV Episodes from this exact series.' + hint);",
    "    }",
    // Merge imported episodes with existing, dedup, preserve order
    "    var existingKeys = new Set(list.episodes.map(function(e) { return e.season + ':' + e.episode; }));",
    "    var allEpsForShow = modalData.tmdbId === list.tmdbId ? modalData.allEpisodes : [];",
    "    var added = 0;",
    "    for (var i = 0; i < d.episodes.length; i++) {",
    "      var ref = d.episodes[i];",
    "      var key = ref.season + ':' + ref.episode;",
    "      if (!existingKeys.has(key)) {",
    "        existingKeys.add(key);",
    // Try to find full episode data from cached modal data; otherwise use minimal ref
    "        var full = allEpsForShow.find(function(e) { return e.season === ref.season && e.episode === ref.episode; });",
    "        list.episodes.push(full || ref);",
    "        added++;",
    "      }",
    "    }",
    "    var msg = 'Added ' + added + ' episode' + (added !== 1 ? 's' : '');",
    "    if (d.skipped) msg += ' (' + d.skipped + ' skipped/not found)';",
    "    if (status) { status.textContent = msg; status.className = 'imdb-import-status ok'; }",
    "    if (input) input.value = '';",
    "    renderCustomSeasonsList();",
    "    setTimeout(function() { var card = document.getElementById('card-' + listId); if (card) card.classList.add('open'); }, 50);",
    "  } catch(e) {",
    "    if (status) { status.textContent = 'Error: ' + e.message; status.className = 'imdb-import-status err'; }",
    "  } finally {",
    "    if (btn) { btn.disabled = false; btn.textContent = 'Import'; }",
    "  }",
    "}",
    "",
    // ── Render lists ─────────────────────────────────────────────────────────
    "function renderCustomSeasonsList() {",
    "  var el  = document.getElementById('custom-seasons-list');",
    "  var cnt = document.getElementById('custom-count');",
    "  cnt.textContent = state.customSeasons.length ? state.customSeasons.length + ' list' + (state.customSeasons.length !== 1 ? 's' : '') : '';",
    "  if (!state.customSeasons.length) { el.innerHTML = '<div class=\"custom-seasons-empty\">No lists yet. Search for a show above to create one.</div>'; return; }",
    "  el.innerHTML = state.customSeasons.map(function(list) {",
    "    var tid = list.listId;",
    "    var ph = list.tmdbPoster ? '<img class=\"list-poster\" src=\"' + list.tmdbPoster + '\" alt=\"\" loading=\"lazy\"/>' : '<div class=\"list-poster\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#128250;</div>';",
    "    var displayName = (list.prefix || '\u2b50') + ' ' + (list.label || 'Best Of') + ' \u2014 ' + list.tmdbName;",
    "    var epItems = list.episodes.map(function(ep, i) {",
    "      var sL = String(ep.season).padStart(2,'0'); var eL = String(ep.episode).padStart(2,'0');",
    "      var th = ep.still ? '<img class=\"ep-thumb\" src=\"' + ep.still + '\" alt=\"\" loading=\"lazy\"/>' : '<div class=\"ep-thumb\" style=\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\">&#127902;</div>';",
    "      return '<li class=\"ep-item\" draggable=\"true\" data-lid=\"' + tid + '\" data-idx=\"' + i + '\">' +",
    "        '<span class=\"ep-rank\">' + (i+1) + '</span><span class=\"ep-drag\">&#8943;</span>' + th +",
    "        '<div class=\"ep-info\"><div class=\"ep-label\">S' + sL + 'E' + eL + ' \u2014 ' + esc(ep.name || 'Episode') + '</div><div class=\"ep-sublabel\">' + (ep.air_date || '') + '</div></div>' +",
    "        (ep.vote_average > 0 ? '<span class=\"ep-rating\">&#11088;' + ep.vote_average.toFixed(1) + '</span>' : '') +",
    "        '<span class=\"ep-del\" onclick=\"removeEp(\\'' + tid + '\\',' + i + ')\" title=\"Remove\">&#10005;</span></li>';",
    "    }).join('');",
    "    return '<div class=\"list-card\" id=\"card-' + tid + '\">' +",
    "      '<div class=\"list-card-header\" onclick=\"toggleCard(\\'' + tid + '\\')\">'+ph+",
    "      '<div class=\"list-card-meta\"><div class=\"list-card-name\" id=\"list-name-' + tid + '\">' + esc(displayName) + '</div><div class=\"list-card-sub\">' + list.tmdbName + '</div></div>' +",
    "      '<span class=\"list-card-count\">' + list.episodes.length + ' ep' + (list.episodes.length !== 1 ? 's' : '') + '</span>' +",
    "      '<span class=\"list-card-chevron\">&rsaquo;</span></div>' +",
    "      '<div class=\"list-card-body\">' +",
    // Prefix + label editors
    "        '<div class=\"list-meta-row\">' +",
    "          '<div class=\"field prefix-field\"><label>Prefix</label><input type=\"text\" value=\"' + esc(list.prefix || '\u2b50') + '\" placeholder=\"\u2b50\" oninput=\"updateListMeta(\\'' + tid + '\\',\\'prefix\\',this.value)\" style=\"text-align:center;font-size:1.2rem;\"/></div>' +",
    "          '<div class=\"field\"><label>List Label</label><input type=\"text\" value=\"' + esc(list.label || 'Best Of') + '\" placeholder=\"Best Of\" oninput=\"updateListMeta(\\'' + tid + '\\',\\'label\\',this.value)\"/></div>' +",
    "          '<button class=\"btn btn-secondary btn-sm\" style=\"margin-bottom:0;align-self:flex-end\" onclick=\"openModal(\\'' + tid + '\\')\">Pick Episodes</button>' +",
    "        '</div>' +",
    // IMDB import
    "        '<div style=\"margin-bottom:10px\">' +",
    "          '<label>Import from IMDB List</label>' +",
    "          '<div class=\"imdb-import-row\">' +",
    "            '<input type=\"text\" id=\"imdb-url-' + tid + '\" placeholder=\"https://www.imdb.com/list/ls086682535/\"/>' +",
    "            '<button class=\"btn btn-secondary btn-sm\" id=\"imdb-btn-' + tid + '\" onclick=\"importImdbList(\\'' + tid + '\\')\" style=\"white-space:nowrap\">Import</button>' +",
    "          '</div>' +",
    "          '<div class=\"imdb-import-status\" id=\"imdb-status-' + tid + '\"></div>' +",
    "        '</div>' +",
    // Episode list
    "        '<ul class=\"ep-list\" id=\"eplist-' + tid + '\" data-lid=\"' + tid + '\">' + (epItems || '<li style=\"color:var(--text-mute);font-size:0.82rem;padding:8px 0\">No episodes yet. Pick manually or import from IMDB.</li>') + '</ul>' +",
    "        '<div class=\"ep-list-actions\"><button class=\"btn btn-danger btn-sm\" onclick=\"removeList(\\'' + tid + '\\')\">Delete List</button></div>' +",
    "      '</div>' +",
    "    '</div>';",
    "  }).join('');",
    "  state.customSeasons.forEach(function(list) { initDragSort(list.listId); });",
    "}",
    "",
    // ── Drag sort ────────────────────────────────────────────────────────────
    "function initDragSort(listId) {",
    "  var listEl = document.getElementById('eplist-' + listId);",
    "  if (!listEl) return;",
    "  var dragIdx = null;",
    "  listEl.querySelectorAll('.ep-item').forEach(function(item, idx) {",
    "    item.addEventListener('dragstart', function(e) { dragIdx = idx; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });",
    "    item.addEventListener('dragend',   function()  { item.classList.remove('dragging'); });",
    "    item.addEventListener('dragover',  function(e) { e.preventDefault(); listEl.querySelectorAll('.ep-item').forEach(function(i) { i.classList.remove('drag-over'); }); item.classList.add('drag-over'); });",
    "    item.addEventListener('dragleave', function()  { item.classList.remove('drag-over'); });",
    "    item.addEventListener('drop', function(e) {",
    "      e.preventDefault(); item.classList.remove('drag-over');",
    "      var dropIdx = parseInt(item.dataset.idx);",
    "      if (dragIdx === null || dragIdx === dropIdx) return;",
    "      var list = getList(listId);",
    "      if (!list) return;",
    "      var moved = list.episodes.splice(dragIdx, 1)[0];",
    "      list.episodes.splice(dropIdx, 0, moved);",
    "      renderCustomSeasonsList();",
    "      var card = document.getElementById('card-' + listId);",
    "      if (card) card.classList.add('open');",
    "    });",
    "  });",
    "}",
    "",
    // ── Install page ─────────────────────────────────────────────────────────
    "function buildInstallPage() {",
    "  var flat = state.customSeasons.map(function(list) {",
    "    return {",
    "      listId:   list.listId,",
    "      tmdbId:   list.tmdbId,",
    "      label:    list.label || 'Best Of',",
    "      prefix:   list.prefix || '\u2b50',",
    "      episodes: list.episodes.map(function(e) { return { season: e.season, episode: e.episode }; }),",
    "    };",
    "  });",
    "  var cfg = { tmdbApiKey: state.apiKey, topN: state.topN, showAutoSeason: state.showAutoSeason, customSeasons: flat, catalogEnabled: state.catalogEnabled, customCatalogs: state.customCatalogs };",
    "  var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));",
    "  var manifestUrl = window.location.origin + '/' + encoded + '/manifest.json';",
    "  document.getElementById('manifest-url').value = manifestUrl;",
    "  var listCount = state.customSeasons.length;",
    "  var showCount = new Set(state.customSeasons.map(function(l) { return l.tmdbId; })).size;",
    "  var enabledDefaultCount = DEFAULT_CATALOGS.filter(function(d) { var ov = state.catalogEnabled[d.id]; return ov !== undefined ? ov : d.enabled; }).length;",
    "  var customCatCount = state.customCatalogs.length;",
    "  document.getElementById('install-summary').innerHTML =",
    "    '<div class=\"summary-row\"><span class=\"summary-label\">Default catalogs enabled</span><span class=\"summary-value accent\">' + enabledDefaultCount + '</span></div>' +",
    "    '<div class=\"summary-row\"><span class=\"summary-label\">Custom catalogs</span><span class=\"summary-value ' + (customCatCount > 0 ? 'gold' : '') + '\">' + (customCatCount > 0 ? customCatCount : 'None') + '</span></div>' +",
    "    '<div class=\"summary-row\"><span class=\"summary-label\">Auto Best Of (Season 0)</span><span class=\"summary-value ' + (state.showAutoSeason ? 'accent' : '') + '\">' + (state.showAutoSeason ? 'On \u00b7 top ' + state.topN : 'Off') + '</span></div>' +",
    "    '<div class=\"summary-row\" style=\"margin-bottom:1.4rem\"><span class=\"summary-label\">Custom Best Of lists</span><span class=\"summary-value ' + (listCount > 0 ? 'gold' : '') + '\">' + (listCount > 0 ? listCount + ' list' + (listCount !== 1 ? 's' : '') + ' across ' + showCount + ' show' + (showCount !== 1 ? 's' : '') : 'None') + '</span></div>';",
    "}",
    "",
    "function openStremio() { var url = document.getElementById('manifest-url').value; if (!url) return; window.location.href = url.replace(/^https?:\\/\\//, 'stremio://'); }",
    "function copyUrl() {",
    "  var input = document.getElementById('manifest-url');",
    "  input.select();",
    "  try { document.execCommand('copy'); } catch(e) { navigator.clipboard && navigator.clipboard.writeText(input.value); }",
    "  var btn = document.getElementById('copy-btn');",
    "  btn.textContent = 'Copied!'; btn.classList.add('copied');",
    "  setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);",
    "}",
    "",
    "function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }",
    "function esc4attr(s) { return String(s || '').replace(/'/g, '&#39;'); }",
  ].join('\n');

  // ── HTML ───────────────────────────────────────────────────────────────────
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>\n' +
    '<title>TMDB Best Of - Configure</title>\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">\n' +
    '<style>\n' + css + '\n</style>\n</head>\n<body>\n' +
    '<div class="app">\n' +
    '  <div class="topbar">\n' +
    '    <div class="topbar-logo">&#127916; TMDB Best Of</div>\n' +
    '    <div class="topbar-steps">\n' +
    '      <div class="step-item active" id="step-tab-1"><span class="step-num">1</span><span>API Key</span></div><span class="step-divider">&rsaquo;</span>\n' +
    '      <div class="step-item" id="step-tab-2"><span class="step-num">2</span><span>Catalogs</span></div><span class="step-divider">&rsaquo;</span>\n' +
    '      <div class="step-item" id="step-tab-3"><span class="step-num">3</span><span>Best Of Lists</span></div><span class="step-divider">&rsaquo;</span>\n' +
    '      <div class="step-item" id="step-tab-4"><span class="step-num">4</span><span>Install</span></div>\n' +
    '    </div>\n  </div>\n' +
    '  <div class="main">\n' +

    // PAGE 1
    '    <div class="page active" id="page-1"><div class="card">\n' +
    '      <div style="text-align:center;padding:1rem 0 1.8rem;font-size:4rem;opacity:0.6">&#128273;</div>\n' +
    '      <div class="card-title">Connect to TMDB</div>\n' +
    '      <div class="card-sub">Enter your free TMDB API key to get started.</div>\n' +
    '      <div class="features-grid">\n' +
    '        <div class="feature-chip">&#127916; Movie metadata</div><div class="feature-chip">&#128250; Series metadata</div>\n' +
    '        <div class="feature-chip">&#128269; TMDB search</div><div class="feature-chip">&#128198; TMDB catalogs</div>\n' +
    '        <div class="feature-chip">&#11088; Auto Best Of season</div><div class="feature-chip">&#128203; IMDB list import</div>\n' +
    '      </div>\n' +
    '      <div class="field"><label>TMDB API Key (v3)</label><input type="password" id="apiKey" placeholder="Paste your API key here..." autocomplete="off" spellcheck="false" onkeydown="if(event.key===\'Enter\') validateApiKey()"/><p class="hint">Free key from <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a></p></div>\n' +
    '      <div class="field"><label>Default top episodes count</label><input type="number" id="topN" placeholder="20" min="5" max="100"/><p class="hint">Top N episodes in auto Season 0. Default: 20. Streams don\'t work from Season 0.</p></div>\n' +
    '      <div class="catalog-row" style="margin-bottom:1.2rem"><div class="catalog-row-info"><div class="catalog-row-name">Show auto Best Of (Season 0)</div><div class="catalog-row-type">Adds a Season 0 with top-rated episodes inside every show. Display only — streams won\'t work. Disable if you only use custom Best Of lists.</div></div><label class="toggle"><input type="checkbox" id="showAutoSeason" checked/><span class="toggle-slider"></span></label></div>\n' +
    '      <button class="btn btn-primary btn-lg" style="width:100%" onclick="validateApiKey()" id="btn-validate">Continue &rarr;</button>\n' +
    '    </div></div>\n' +

    // PAGE 2
    '    <div class="page" id="page-2">\n' +
    '      <div class="card"><div class="card-title">&#128198; TMDB Catalogs</div><div class="card-sub">Choose which TMDB catalogs appear in Stremio.</div>\n' +
    '        <div class="catalog-section-label">&#127916; Movies</div><div id="catalog-defaults-movie"></div>\n' +
    '        <div class="catalog-section-label">&#128250; Series</div><div id="catalog-defaults-series"></div>\n' +
    '      </div>\n' +
    '      <div class="card"><div class="section-header"><div><div class="card-title">&#10133; Custom Catalogs</div><div class="card-sub" style="margin-bottom:0">Create TMDB Discover catalogs with custom filters.</div></div><button class="btn btn-secondary btn-sm" onclick="toggleCustomCatalogForm()">+ Add</button></div>\n' +
    '        <div class="custom-catalog-form" id="custom-catalog-form">\n' +
    '          <div class="form-row"><div class="field" style="margin-bottom:0"><label>Catalog Name</label><input type="text" id="cc-name" placeholder="e.g. Sci-Fi Classics"/></div><div class="field" style="margin-bottom:0"><label>Type</label><select id="cc-type" onchange="loadGenresForCustom()"><option value="movie">Movie</option><option value="series">Series</option></select></div></div>\n' +
    '          <div class="form-row" style="margin-top:10px"><div class="field" style="margin-bottom:0"><label>Genre Filter</label><select id="cc-genre"><option value="">Any Genre</option></select></div><div class="field" style="margin-bottom:0"><label>Sort By</label><select id="cc-sort"><option value="popularity.desc">Most Popular</option><option value="vote_average.desc">Highest Rated</option><option value="release_date.desc">Newest First</option><option value="revenue.desc">Highest Revenue</option></select></div></div>\n' +
    '          <div style="display:flex;gap:8px;margin-top:14px"><button class="btn btn-primary btn-sm" onclick="addCustomCatalog()">Add Catalog</button><button class="btn btn-secondary btn-sm" onclick="toggleCustomCatalogForm()">Cancel</button></div>\n' +
    '        </div>\n' +
    '        <div id="custom-catalogs-list" style="margin-top:14px"><div class="custom-seasons-empty">No custom catalogs yet.</div></div>\n' +
    '      </div>\n' +
    '      <div class="nav-row"><button class="btn btn-secondary" onclick="goTo(1)">&larr; Back</button><button class="btn btn-primary btn-lg" onclick="goTo(3)">Next &rarr;</button></div>\n' +
    '    </div>\n' +

    // PAGE 3
    '    <div class="page" id="page-3">\n' +
    '      <div class="card">\n' +
    '        <div class="card-title">&#11088; Custom Best Of Lists</div>\n' +
    '        <div class="card-sub">Search for a show to create a named list. Each list becomes its own entry in the &#11088; Best Of catalog. You can have multiple lists per show, each with a custom prefix and label. Streams work from these entries.<br><br>Import episodes from any public IMDB list, or pick them manually. You can also mix both.</div>\n' +
    '        <div class="search-wrap field"><span class="search-icon">&#128269;</span><input type="text" id="series-search" placeholder="Search for a TV show to create a list..." oninput="debounceSearch(this.value)" autocomplete="off"/></div>\n' +
    '        <div id="search-results" class="search-results"></div>\n' +
    '      </div>\n' +
    '      <div class="card"><div class="section-header"><span class="section-title">Your Best Of Lists</span><span id="custom-count" style="font-size:0.75rem;color:var(--text-dim)"></span></div>\n' +
    '        <div id="custom-seasons-list"><div class="custom-seasons-empty">No lists yet. Search for a show above to get started.</div></div>\n' +
    '      </div>\n' +
    '      <div class="nav-row"><button class="btn btn-secondary" onclick="goTo(2)">&larr; Back</button><button class="btn btn-gold btn-lg" onclick="goTo(4)">Generate Install Link &rarr;</button></div>\n' +
    '    </div>\n' +

    // PAGE 4
    '    <div class="page" id="page-4"><div class="card">\n' +
    '      <div class="generate-hero"><div style="font-size:3.5rem;margin-bottom:12px">&#128640;</div><h2>Ready to install!</h2><p>Your addon is configured. Click below to add it directly to Stremio.</p></div>\n' +
    '      <div id="install-summary"></div>\n' +
    '      <button class="btn btn-install" onclick="openStremio()">&#9889; Install in Stremio</button>\n' +
    '      <div class="or-line">-- or add manually --</div>\n' +
    '      <div class="copy-row"><input type="text" id="manifest-url" readonly/><button class="btn-copy" id="copy-btn" onclick="copyUrl()">Copy</button></div>\n' +
    '    </div><div class="nav-row"><button class="btn btn-secondary" onclick="goTo(3)">&larr; Back</button></div></div>\n' +

    '  </div>\n</div>\n' +

    // Modal
    '<div class="modal-backdrop" id="modal-backdrop" onclick="closeModalOnBackdrop(event)">\n' +
    '  <div class="modal">\n' +
    '    <div class="modal-header"><img class="modal-poster" id="modal-poster" src="" alt=""/><div><div class="modal-title" id="modal-show-name">Loading...</div><div class="modal-sub" id="modal-show-sub"></div></div><div class="modal-close" onclick="closeModal()">&#10005;</div></div>\n' +
    '    <div class="modal-filter" id="modal-season-filters"></div>\n' +
    '    <div class="modal-ep-list" id="modal-ep-list"><div class="loading-overlay"><div class="spinner"></div> Loading episodes...</div></div>\n' +
    '    <div class="modal-footer"><span class="modal-selected-count">Selected: <span id="modal-sel-count">0</span></span><div style="display:flex;gap:8px"><button class="btn btn-secondary btn-sm" onclick="closeModal()">Cancel</button><button class="btn btn-primary btn-sm" onclick="addSelectedEpisodes()">Save Selection</button></div></div>\n' +
    '  </div>\n</div>\n' +
    '<script>\n' + clientJS + '\n</script>\n</body>\n</html>';
}

const PORT = process.env.PORT || 7000;
app.listen(PORT, function() {
  console.log('TMDB Best Of addon running on port ' + PORT);
  console.log('Configure: http://localhost:' + PORT + '/configure');
});