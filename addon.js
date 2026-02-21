const express = require(‘express’);
const axios   = require(‘axios’);

const app = express();
app.use(express.json());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
res.setHeader(‘Access-Control-Allow-Origin’,  ‘*’);
res.setHeader(‘Access-Control-Allow-Headers’, ’*’);
next();
});

// ─── Constants ────────────────────────────────────────────────────────────────
const TMDB   = ‘https://api.themoviedb.org/3’;
const OMDB   = ‘https://www.omdbapi.com’;
const IMG_SM = ‘https://image.tmdb.org/t/p/w300’;
const IMG_MD = ‘https://image.tmdb.org/t/p/w500’;
const IMG_LG = ‘https://image.tmdb.org/t/p/w1280’;

// Catalog IDs — must match what’s declared in the manifest
const CAT_MOVIE_POPULAR  = ‘tmdb.movies.popular’;
const CAT_MOVIE_TOPRATED = ‘tmdb.movies.toprated’;
const CAT_MOVIE_SEARCH   = ‘tmdb.movies.search’;
const CAT_TV_POPULAR     = ‘tmdb.tv.popular’;
const CAT_TV_TOPRATED    = ‘tmdb.tv.toprated’;
const CAT_TV_SEARCH      = ‘tmdb.tv.search’;

// ─── Config helpers ───────────────────────────────────────────────────────────
function parseConfig(str) {
try { return JSON.parse(Buffer.from(str, ‘base64’).toString(‘utf8’)); }
catch { return {}; }
}

// ─── TMDB fetch ───────────────────────────────────────────────────────────────
async function tmdb(path, apiKey, params = {}) {
const url = new URL(`${TMDB}${path}`);
url.searchParams.set(‘api_key’, apiKey);
url.searchParams.set(‘language’, ‘en-US’);
for (const [k, v] of Object.entries(params)) {
if (v !== undefined && v !== null && v !== ‘’) url.searchParams.set(k, v);
}
try {
const { data } = await axios.get(url.toString(), { timeout: 10000 });
return data;
} catch (e) {
throw new Error(`TMDB ${path} failed: ${e.response?.status || e.message}`);
}
}

// ─── OMDB fetch — returns IMDB rating (number) or null ───────────────────────
async function omdbRating(imdbEpisodeId, omdbApiKey) {
if (!imdbEpisodeId || !omdbApiKey) return null;
try {
const url = new URL(OMDB);
url.searchParams.set(‘i’,      imdbEpisodeId);
url.searchParams.set(‘apikey’, omdbApiKey);
url.searchParams.set(‘type’,   ‘episode’);
const { data } = await axios.get(url.toString(), { timeout: 6000 });
if (data.Response === ‘True’ && data.imdbRating && data.imdbRating !== ‘N/A’) {
return parseFloat(data.imdbRating);
}
return null;
} catch { return null; }
}

// ─── TMDB result → Stremio meta (brief, for catalogs) ────────────────────────
function movieToMeta(m) {
return {
id:          `tmdb:${m.id}`,
type:        ‘movie’,
name:        m.title || m.original_title || ‘Unknown’,
poster:      m.poster_path   ? `${IMG_MD}${m.poster_path}`   : null,
background:  m.backdrop_path ? `${IMG_LG}${m.backdrop_path}` : null,
description: m.overview,
releaseInfo: m.release_date  ? m.release_date.substring(0, 4)  : ‘’,
imdbRating:  m.vote_average  ? m.vote_average.toFixed(1)        : null,
genres:      m.genre_ids     ? genreNames(‘movie’, m.genre_ids) : [],
};
}

function tvToMeta(s) {
return {
id:          `tmdb:${s.id}`,
type:        ‘series’,
name:        s.name || s.original_name || ‘Unknown’,
poster:      s.poster_path   ? `${IMG_MD}${s.poster_path}`   : null,
background:  s.backdrop_path ? `${IMG_LG}${s.backdrop_path}` : null,
description: s.overview,
releaseInfo: s.first_air_date ? s.first_air_date.substring(0, 4) : ‘’,
imdbRating:  s.vote_average   ? s.vote_average.toFixed(1)         : null,
genres:      s.genre_ids      ? genreNames(‘tv’, s.genre_ids)     : [],
};
}

// ─── Genre ID → name lookup (static TMDB lists) ───────────────────────────────
const MOVIE_GENRES = {
28:‘Action’,12:‘Adventure’,16:‘Animation’,35:‘Comedy’,80:‘Crime’,
99:‘Documentary’,18:‘Drama’,10751:‘Family’,14:‘Fantasy’,36:‘History’,
27:‘Horror’,10402:‘Music’,9648:‘Mystery’,10749:‘Romance’,878:‘Science Fiction’,
10770:‘TV Movie’,53:‘Thriller’,10752:‘War’,37:‘Western’
};
const TV_GENRES = {
10759:‘Action & Adventure’,16:‘Animation’,35:‘Comedy’,80:‘Crime’,
99:‘Documentary’,18:‘Drama’,10751:‘Family’,10762:‘Kids’,9648:‘Mystery’,
10763:‘News’,10764:‘Reality’,10765:‘Sci-Fi & Fantasy’,10766:‘Soap’,
10767:‘Talk’,10768:‘War & Politics’,37:‘Western’
};
function genreNames(type, ids) {
const map = type === ‘movie’ ? MOVIE_GENRES : TV_GENRES;
return (ids || []).map(id => map[id]).filter(Boolean);
}

// ─── Episode helpers ──────────────────────────────────────────────────────────
async function getAllEpisodes(tmdbId, apiKey, totalSeasons) {
const episodes = [];
for (let s = 1; s <= totalSeasons; s++) {
try {
const season = await tmdb(`/tv/${tmdbId}/season/${s}`, apiKey);
for (const ep of (season.episodes || [])) {
episodes.push({
season:       s,
episode:      ep.episode_number,
name:         ep.name         || `Episode ${ep.episode_number}`,
overview:     ep.overview     || ‘’,
still:        ep.still_path   ? `${IMG_SM}${ep.still_path}` : null,
vote_average: ep.vote_average || 0,
vote_count:   ep.vote_count   || 0,
air_date:     ep.air_date,
imdb_ep_id:   null, // populated by enrichWithImdbRatings if rankBy === ‘imdb’
imdb_rating:  null,
});
}
} catch { /* skip broken seasons */ }
}
return episodes;
}

// Fetches the IMDB episode ID from TMDB external_ids, then queries OMDB for the
// rating. Runs in small parallel batches to stay within rate limits.
async function enrichWithImdbRatings(episodes, tmdbSeriesId, tmdbApiKey, omdbApiKey) {
const BATCH = 5;
for (let i = 0; i < episodes.length; i += BATCH) {
await Promise.all(episodes.slice(i, i + BATCH).map(async (ep) => {
try {
const extIds = await tmdb(
`/tv/${tmdbSeriesId}/season/${ep.season}/episode/${ep.episode}/external_ids`,
tmdbApiKey,
);
ep.imdb_ep_id = extIds.imdb_id || null;
if (ep.imdb_ep_id) {
ep.imdb_rating = await omdbRating(ep.imdb_ep_id, omdbApiKey);
}
} catch { /* leave nulls */ }
}));
}
}

// Returns the top N episodes sorted by the chosen ranking source.
// rankBy: ‘tmdb’ (default) | ‘imdb’
async function getTopEpisodes(tmdbId, apiKey, totalSeasons, topN = 20, rankBy = ‘tmdb’, omdbApiKey = null) {
const all = await getAllEpisodes(tmdbId, apiKey, totalSeasons);

if (rankBy === ‘imdb’ && omdbApiKey) {
// Pre-filter by TMDB vote_count to limit OMDB calls, then re-sort by IMDB rating
const candidates = all.filter(e => e.vote_count >= 5);
await enrichWithImdbRatings(candidates, tmdbId, apiKey, omdbApiKey);
candidates.sort((a, b) => {
const ar = a.imdb_rating ?? -1;
const br = b.imdb_rating ?? -1;
return br - ar || b.vote_average - a.vote_average;
});
return candidates.slice(0, topN);
}

// Default: sort by TMDB vote_average
const filtered = all.filter(e => e.vote_count >= 5);
filtered.sort((a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count);
return filtered.slice(0, topN);
}

// ─── Certification helpers ────────────────────────────────────────────────────
function getSeriesCert(data) {
try {
const us = (data.content_ratings?.results || []).find(r => r.iso_3166_1 === ‘US’);
return us?.rating || null;
} catch { return null; }
}
function getMovieCert(data) {
try {
const us  = (data.release_dates?.results || []).find(r => r.iso_3166_1 === ‘US’);
const rel = (us?.release_dates || []).find(d => d.type === 3 || d.type === 4);
return rel?.certification || null;
} catch { return null; }
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
app.get(’/manifest.json’,         (req, res) => res.json(buildManifest()));
app.get(’/:config/manifest.json’, (req, res) => res.json(buildManifest(req.params.config)));

function buildManifest(config) {
const cfg = config ? parseConfig(config) : {};
return {
id:          ‘community.tmdb-complete’,
version:     ‘3.1.0’,
name:        ‘TMDB Complete’,
description: ‘Full TMDB catalog, search, and metadata for movies & series. Adds a ⭐ Best Of season to every show.’,
logo:        ‘https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg’,
resources:   [‘catalog’, ‘meta’, ‘episodeVideos’],
types:       [‘movie’, ‘series’],
idPrefixes:  [‘tmdb:’],
behaviorHints: {
configurable:          true,
configurationRequired: !cfg.tmdbApiKey,
},
config: [
{ key: ‘tmdbApiKey’, type: ‘text’,   title: ‘TMDB API Key’,                                required: true  },
{ key: ‘rankBy’,     type: ‘select’, title: ‘Best Of — rank episodes by’,                  required: false,
options: [‘TMDB Rating’, ‘IMDB Rating’] },
{ key: ‘omdbApiKey’, type: ‘text’,   title: ‘OMDB API Key (required for IMDB ranking)’,    required: false },
{ key: ‘topN’,       type: ‘number’, title: ‘Top episodes in Best Of season (default 20)’, required: false },
],
catalogs: [
// ── Movies ──────────────────────────────────────────────────────────
{
id:   CAT_MOVIE_POPULAR,
type: ‘movie’,
name: ‘TMDB — Popular Movies’,
extra: [
{ name: ‘skip’,  isRequired: false },
{ name: ‘genre’, isRequired: false, options: Object.values(MOVIE_GENRES) },
],
},
{
id:   CAT_MOVIE_TOPRATED,
type: ‘movie’,
name: ‘TMDB — Top Rated Movies’,
extra: [
{ name: ‘skip’,  isRequired: false },
{ name: ‘genre’, isRequired: false, options: Object.values(MOVIE_GENRES) },
],
},
{
id:   CAT_MOVIE_SEARCH,
type: ‘movie’,
name: ‘TMDB — Search Movies’,
extra: [{ name: ‘search’, isRequired: true }],
},
// ── TV ───────────────────────────────────────────────────────────────
{
id:   CAT_TV_POPULAR,
type: ‘series’,
name: ‘TMDB — Popular Series’,
extra: [
{ name: ‘skip’,  isRequired: false },
{ name: ‘genre’, isRequired: false, options: Object.values(TV_GENRES) },
],
},
{
id:   CAT_TV_TOPRATED,
type: ‘series’,
name: ‘TMDB — Top Rated Series’,
extra: [
{ name: ‘skip’,  isRequired: false },
{ name: ‘genre’, isRequired: false, options: Object.values(TV_GENRES) },
],
},
{
id:   CAT_TV_SEARCH,
type: ‘series’,
name: ‘TMDB — Search Series’,
extra: [{ name: ‘search’, isRequired: true }],
},
],
};
}

// ─── Configure page ───────────────────────────────────────────────────────────
app.get(’/’,          (req, res) => res.redirect(’/configure’));
app.get(’/configure’, (req, res) => res.send(configurePage()));

// ─── Catalog handler ──────────────────────────────────────────────────────────
app.get(’/:config/catalog/:type/:id/:extra?.json’, async (req, res) => {
const { config, type, id } = req.params;
const cfg = parseConfig(config);
if (!cfg.tmdbApiKey) return res.status(400).json({ metas: [] });

const extraStr   = req.params.extra || ‘’;
const extraPairs = {};
for (const part of extraStr.split(’&’)) {
const [k, v] = part.split(’=’);
if (k && v !== undefined) extraPairs[decodeURIComponent(k)] = decodeURIComponent(v.replace(/+/g, ’ ’));
}

const skip   = parseInt(extraPairs.skip || ‘0’);
const page   = Math.floor(skip / 20) + 1;
const search = extraPairs.search || ‘’;
const genre  = extraPairs.genre  || ‘’;

function genreId(map, name) {
return Object.entries(map).find(([, n]) => n === name)?.[0] || null;
}

try {
let metas = [];

```
if (type === 'movie') {
  if (id === CAT_MOVIE_SEARCH && search) {
    const data = await tmdb('/search/movie', cfg.tmdbApiKey, { query: search, page });
    metas = (data.results || []).map(movieToMeta);

  } else if (id === CAT_MOVIE_POPULAR) {
    const gid  = genre ? genreId(MOVIE_GENRES, genre) : null;
    const data = await tmdb('/discover/movie', cfg.tmdbApiKey, {
      sort_by: 'popularity.desc', with_genres: gid || '', page, 'vote_count.gte': 50,
    });
    metas = (data.results || []).map(movieToMeta);

  } else if (id === CAT_MOVIE_TOPRATED) {
    const gid  = genre ? genreId(MOVIE_GENRES, genre) : null;
    const data = await tmdb('/discover/movie', cfg.tmdbApiKey, {
      sort_by: 'vote_average.desc', with_genres: gid || '', page, 'vote_count.gte': 200,
    });
    metas = (data.results || []).map(movieToMeta);
  }
}

if (type === 'series') {
  if (id === CAT_TV_SEARCH && search) {
    const data = await tmdb('/search/tv', cfg.tmdbApiKey, { query: search, page });
    metas = (data.results || []).map(tvToMeta);

  } else if (id === CAT_TV_POPULAR) {
    const gid  = genre ? genreId(TV_GENRES, genre) : null;
    const data = await tmdb('/discover/tv', cfg.tmdbApiKey, {
      sort_by: 'popularity.desc', with_genres: gid || '', page, 'vote_count.gte': 50,
    });
    metas = (data.results || []).map(tvToMeta);

  } else if (id === CAT_TV_TOPRATED) {
    const gid  = genre ? genreId(TV_GENRES, genre) : null;
    const data = await tmdb('/discover/tv', cfg.tmdbApiKey, {
      sort_by: 'vote_average.desc', with_genres: gid || '', page, 'vote_count.gte': 200,
    });
    metas = (data.results || []).map(tvToMeta);
  }
}

res.json({ metas });
```

} catch (e) {
console.error(’[catalog]’, e.message);
res.json({ metas: [] });
}
});

// ─── Movie meta ───────────────────────────────────────────────────────────────
app.get(’/:config/meta/movie/:id.json’, async (req, res) => {
const { config, id } = req.params;
const cfg = parseConfig(config);
if (!cfg.tmdbApiKey) return res.status(400).json({ meta: null });
if (!id.startsWith(‘tmdb:’)) return res.json({ meta: null });

const tmdbId = id.replace(‘tmdb:’, ‘’);

try {
const movie    = await tmdb(`/movie/${tmdbId}`, cfg.tmdbApiKey, {
append_to_response: ‘external_ids,release_dates,credits,videos’,
});
const cert     = getMovieCert(movie);
const director = (movie.credits?.crew || []).find(c => c.job === ‘Director’);
const cast     = (movie.credits?.cast || []).slice(0, 8).map(c => c.name);
const trailer  = (movie.videos?.results || []).find(v => v.type === ‘Trailer’ && v.site === ‘YouTube’);

```
res.json({
  meta: {
    id,
    type:          'movie',
    name:          movie.title || movie.original_title,
    poster:        movie.poster_path   ? `${IMG_MD}${movie.poster_path}`   : null,
    background:    movie.backdrop_path ? `${IMG_LG}${movie.backdrop_path}` : null,
    description:   movie.overview,
    releaseInfo:   movie.release_date  ? movie.release_date.substring(0, 4) : '',
    runtime:       movie.runtime       ? `${movie.runtime} min`             : null,
    genres:        (movie.genres || []).map(g => g.name),
    imdbRating:    movie.vote_average  ? movie.vote_average.toFixed(1)      : null,
    cast,
    director:      director?.name || null,
    certification: cert           || null,
    trailers:      trailer ? [{ source: 'yt', type: 'Trailer', ytId: trailer.key }] : [],
    links:         movie.external_ids?.imdb_id
      ? [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${movie.external_ids.imdb_id}` }]
      : [],
  },
});
```

} catch (e) {
console.error(’[movie meta]’, e.message);
res.status(500).json({ meta: null });
}
});

// ─── Series meta + Best Of season ────────────────────────────────────────────
app.get(’/:config/meta/series/:id.json’, async (req, res) => {
const { config, id } = req.params;
const cfg = parseConfig(config);
if (!cfg.tmdbApiKey) return res.status(400).json({ meta: null });
if (!id.startsWith(‘tmdb:’)) return res.json({ meta: null });

const tmdbId  = id.replace(‘tmdb:’, ‘’);
const topN    = parseInt(cfg.topN) || 20;
const rankBy  = cfg.rankBy === ‘IMDB Rating’ ? ‘imdb’ : ‘tmdb’;
const omdbKey = cfg.omdbApiKey || null;

try {
const series = await tmdb(`/tv/${tmdbId}`, cfg.tmdbApiKey, {
append_to_response: ‘external_ids,content_ratings,credits’,
});
const cert = getSeriesCert(series);
const cast = (series.credits?.cast || []).slice(0, 8).map(c => c.name);
const videos = [];

```
// ── All real seasons/episodes ──────────────────────────────────────
for (let s = 1; s <= (series.number_of_seasons || 0); s++) {
  try {
    const season = await tmdb(`/tv/${tmdbId}/season/${s}`, cfg.tmdbApiKey);
    for (const ep of (season.episodes || [])) {
      videos.push({
        id:        `${id}:${s}:${ep.episode_number}`,
        title:     ep.name || `Episode ${ep.episode_number}`,
        season:    s,
        episode:   ep.episode_number,
        overview:  ep.overview || '',
        thumbnail: ep.still_path ? `${IMG_SM}${ep.still_path}` : null,
        released:  ep.air_date  ? new Date(ep.air_date)         : null,
        rating:    ep.vote_average ? ep.vote_average.toFixed(1) : null,
      });
    }
  } catch { /* skip */ }
}

// ── Virtual Season 0 — Best Of ────────────────────────────────────
const topEps = await getTopEpisodes(
  tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN, rankBy, omdbKey,
);

topEps.forEach((ep, i) => {
  const rank   = i + 1;
  const sLabel = String(ep.season).padStart(2, '0');
  const eLabel = String(ep.episode).padStart(2, '0');
  // Show both ratings in the overview, labelling which one was used for ranking
  const ratingLine = rankBy === 'imdb' && ep.imdb_rating != null
    ? `⭐ IMDB ${ep.imdb_rating.toFixed(1)}/10  ·  TMDB ${ep.vote_average.toFixed(1)}/10`
    : `⭐ TMDB ${ep.vote_average.toFixed(1)}/10  (${ep.vote_count.toLocaleString()} votes)`;
  videos.push({
    id:        `${id}:0:${rank}`,
    title:     `#${rank} — S${sLabel}E${eLabel} — ${ep.name}`,
    season:    0,
    episode:   rank,
    overview:  `${ratingLine}\n\n${ep.overview || ''}`,
    thumbnail: ep.still || null,
    released:  ep.air_date ? new Date(ep.air_date) : null,
  });
});

const startYear   = series.first_air_date?.substring(0, 4) || '';
const endYear     = series.last_air_date?.substring(0, 4)  || '';
const releaseInfo = series.status === 'Ended' && endYear
  ? `${startYear}–${endYear}` : startYear;

res.json({
  meta: {
    id,
    type:          'series',
    name:          series.name || series.original_name,
    poster:        series.poster_path   ? `${IMG_MD}${series.poster_path}`   : null,
    background:    series.backdrop_path ? `${IMG_LG}${series.backdrop_path}` : null,
    description:   series.overview,
    releaseInfo,
    runtime:       series.episode_run_time?.[0] ? `${series.episode_run_time[0]} min` : null,
    genres:        (series.genres || []).map(g => g.name),
    imdbRating:    series.vote_average   ? series.vote_average.toFixed(1)  : null,
    cast,
    certification: cert || null,
    videos,
    links:         series.external_ids?.imdb_id
      ? [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${series.external_ids.imdb_id}` }]
      : [],
  },
});
```

} catch (e) {
console.error(’[series meta]’, e.message);
res.status(500).json({ meta: null });
}
});

// ─── episodeVideos — resolve Best Of virtual ep → real ep ID ─────────────────
app.get(’/:config/episodeVideos/series/:id.json’, async (req, res) => {
const { config, id } = req.params;
const cfg = parseConfig(config);
if (!cfg.tmdbApiKey) return res.json({ videos: [] });

const parts = id.split(’:’);
if (parts.length < 4 || parts[0] !== ‘tmdb’) return res.json({ videos: [] });

const [, tmdbId, seasonStr, epStr] = parts;
const season     = parseInt(seasonStr);
const episodeNum = parseInt(epStr);
const topN       = parseInt(cfg.topN) || 20;
const rankBy     = cfg.rankBy === ‘IMDB Rating’ ? ‘imdb’ : ‘tmdb’;
const omdbKey    = cfg.omdbApiKey || null;

if (season !== 0) return res.json({ videos: [] });

try {
const [series, topEps] = await Promise.all([
tmdb(`/tv/${tmdbId}`, cfg.tmdbApiKey, { append_to_response: ‘external_ids’ }),
tmdb(`/tv/${tmdbId}`, cfg.tmdbApiKey)
.then(s => getTopEpisodes(tmdbId, cfg.tmdbApiKey, s.number_of_seasons || 1, topN, rankBy, omdbKey)),
]);

```
const target = topEps[episodeNum - 1];
if (!target) return res.json({ videos: [] });

const imdbId  = series.external_ids?.imdb_id;
const videoId = imdbId
  ? `${imdbId}:${target.season}:${target.episode}`
  : `tmdb:${tmdbId}:${target.season}:${target.episode}`;

res.json({
  videos: [{
    id:        videoId,
    title:     target.name,
    season:    target.season,
    episode:   target.episode,
    thumbnail: target.still,
    overview:  target.overview,
  }],
});
```

} catch (e) {
console.error(’[episodeVideos]’, e.message);
res.json({ videos: [] });
}
});

// ─── Configure page ───────────────────────────────────────────────────────────
function configurePage() {
return `<!DOCTYPE html>

<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>TMDB Complete — Configure</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0c0c12; color: #dde1ea;
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 2rem 1rem;
    }
    .card {
      background: #16161f; border: 1px solid #252535; border-radius: 20px;
      padding: 2.8rem 2.4rem 2.4rem; max-width: 520px; width: 100%;
      box-shadow: 0 12px 60px rgba(0,0,0,0.6);
    }
    .header { display: flex; align-items: center; gap: 14px; margin-bottom: 2rem; }
    .icon {
      flex-shrink: 0; width: 52px; height: 52px;
      background: linear-gradient(135deg, #01b4e4, #0d6efd);
      border-radius: 14px;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px;
    }
    h1 { font-size: 1.35rem; font-weight: 700; color: #fff; }
    .subtitle { font-size: 0.78rem; color: #555; margin-top: 3px; }
    .pills { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 2rem; }
    .pill {
      font-size: 0.69rem; font-weight: 600;
      padding: 4px 11px; border-radius: 20px;
      background: #1e1e2d; border: 1px solid #2e2e45; color: #888;
    }
    .pill.blue   { border-color: #01b4e4; color: #01b4e4; }
    .pill.green  { border-color: #90cea1; color: #90cea1; }
    .pill.gold   { border-color: #f5c518; color: #f5c518; }
    .pill.purple { border-color: #9d4edf; color: #9d4edf; }
    .section-label {
      font-size: 0.68rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.1em; color: #444;
      margin-bottom: 1rem;
      display: flex; align-items: center; gap: 10px;
    }
    .section-label::after { content: ''; flex: 1; height: 1px; background: #252535; }
    .field { margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.82rem; color: #bbb; margin-bottom: 6px; font-weight: 500; }
    input[type=text], input[type=number], select {
      width: 100%; background: #0c0c12;
      border: 1.5px solid #252535; border-radius: 10px;
      padding: 11px 14px; color: #e8ecf0; font-size: 0.93rem;
      outline: none; transition: border-color 0.18s;
      appearance: none; -webkit-appearance: none;
    }
    select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23555' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 14px center;
      padding-right: 36px; cursor: pointer;
    }
    select option { background: #16161f; }
    input:focus, select:focus { border-color: #01b4e4; }
    input.error { border-color: #e74c3c !important; animation: shake 0.3s; }
    @keyframes shake {
      0%,100% { transform: translateX(0); }
      25%      { transform: translateX(-4px); }
      75%      { transform: translateX(4px); }
    }
    .hint { font-size: 0.72rem; color: #555; margin-top: 5px; }
    .hint a { color: #01b4e4; text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
    .feature-list {
      background: #0f0f18; border: 1px solid #1e1e2d; border-radius: 12px;
      padding: 1rem 1.2rem; margin-bottom: 1.8rem;
    }
    .feature-list li {
      list-style: none; font-size: 0.82rem; color: #888;
      padding: 4px 0; display: flex; align-items: flex-start; gap: 8px;
    }
    .feature-list li span { flex-shrink: 0; }
    .btn-primary {
      width: 100%; padding: 13px;
      background: linear-gradient(135deg, #01b4e4, #0d6efd);
      border: none; border-radius: 10px;
      color: #fff; font-size: 1rem; font-weight: 700;
      cursor: pointer; transition: opacity 0.18s, transform 0.1s;
      margin-top: 0.4rem;
    }
    .btn-primary:hover { opacity: 0.9; }
    .btn-primary:active { transform: scale(0.98); }
    #result { display: none; margin-top: 1.8rem; }
    .install-btn {
      display: block; width: 100%; padding: 13px;
      background: linear-gradient(135deg, #7b2fbe, #9d4edf);
      border: none; border-radius: 10px;
      color: #fff; font-size: 1rem; font-weight: 700;
      text-align: center; text-decoration: none; cursor: pointer;
      transition: opacity 0.18s;
    }
    .install-btn:hover { opacity: 0.9; }
    .or-line { text-align: center; font-size: 0.72rem; color: #444; margin: 12px 0 10px; }
    .copy-row { display: flex; gap: 8px; }
    .copy-row input { flex: 1; font-size: 0.73rem; color: #555; padding: 9px 12px; }
    .btn-copy {
      flex-shrink: 0; padding: 9px 16px;
      background: #1e1e2d; border: 1.5px solid #2e2e45; border-radius: 10px;
      color: #aaa; font-size: 0.78rem; font-weight: 600;
      cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .btn-copy:hover { background: #252535; color: #fff; }
    .btn-copy.copied { border-color: #90cea1; color: #90cea1; }
    .warning {
      background: #1a1400; border: 1px solid #3d3000;
      border-radius: 10px; padding: 10px 14px;
      font-size: 0.78rem; color: #c8a200; margin-bottom: 1.8rem;
      line-height: 1.5;
    }
    /* OMDB key field slides in/out depending on rankBy selection */
    #omdb-field {
      overflow: hidden;
      max-height: 0;
      opacity: 0;
      transition: max-height 0.3s ease, opacity 0.25s ease;
      margin-bottom: 0;
      pointer-events: none;
    }
    #omdb-field.visible {
      max-height: 120px;
      opacity: 1;
      margin-bottom: 1.5rem;
      pointer-events: auto;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="icon">🎬</div>
      <div>
        <h1>TMDB Complete</h1>
        <p class="subtitle">Stremio Addon &nbsp;·&nbsp; v3.1</p>
      </div>
    </div>

```
<div class="pills">
  <span class="pill blue">🎬 Movies</span>
  <span class="pill blue">📺 Series</span>
  <span class="pill purple">🔍 Search</span>
  <span class="pill green">📋 Catalogs</span>
  <span class="pill green">📄 Full Metadata</span>
  <span class="pill gold">⭐ Best Of Season</span>
</div>

<div class="warning">
  ⚠️ <strong>Disable Cinemeta</strong> in your Stremio addon settings after installing this addon — both provide movie &amp; series metadata and they will conflict.
</div>

<ul class="feature-list">
  <li><span>🔍</span> Search movies &amp; series directly from the Stremio search bar</li>
  <li><span>📈</span> Popular and top-rated catalog rows for both movies &amp; series</li>
  <li><span>🎭</span> Genre filtering on all catalog rows</li>
  <li><span>📋</span> Full metadata: cast, director, rating, runtime, certification, trailer</li>
  <li><span>⭐</span> Every series gets a virtual <strong style="color:#f5c518">Season 0 — Best Of</strong> ranked by TMDB or IMDB rating</li>
</ul>

<div class="section-label">Required</div>
<div class="field">
  <label for="apiKey">TMDB API Key</label>
  <input type="text" id="apiKey" placeholder="Paste your v3 API key here…" autocomplete="off" spellcheck="false"/>
  <p class="hint">
    Free key at
    <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org/settings/api</a>
    — sign up, go to Settings → API, copy the <em>API Key (v3 auth)</em>
  </p>
</div>

<div class="section-label">Optional</div>

<div class="field">
  <label for="rankBy">Best Of — rank episodes by</label>
  <select id="rankBy" onchange="onRankByChange()">
    <option value="TMDB Rating">TMDB Rating (default, no extra key needed)</option>
    <option value="IMDB Rating">IMDB Rating (requires free OMDB API key)</option>
  </select>
  <p class="hint">IMDB ratings are fetched via OMDB and may add a few seconds to load time.</p>
</div>

<div id="omdb-field">
  <label for="omdbKey">OMDB API Key</label>
  <input type="text" id="omdbKey" placeholder="Paste your OMDB key here…" autocomplete="off" spellcheck="false"/>
  <p class="hint">
    Free key (1,000 req/day) at
    <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">omdbapi.com/apikey.aspx</a>
  </p>
</div>

<div class="field">
  <label for="topN">Episodes in Best Of season</label>
  <input type="number" id="topN" placeholder="20" min="5" max="100"/>
  <p class="hint">Default: 20. Higher values fetch more data and load slightly slower.</p>
</div>

<button class="btn-primary" onclick="generate()">Generate Install Link →</button>

<div id="result">
  <a id="stremio-btn" class="install-btn" href="#">⚡ Install in Stremio</a>
  <p class="or-line">— or add manually via manifest URL —</p>
  <div class="copy-row">
    <input type="text" id="manifest-url" readonly/>
    <button class="btn-copy" id="copy-btn" onclick="copyUrl()">Copy</button>
  </div>
</div>
```

  </div>

  <script>
    function onRankByChange() {
      const useImdb = document.getElementById('rankBy').value === 'IMDB Rating';
      document.getElementById('omdb-field').classList.toggle('visible', useImdb);
    }

    function generate() {
      const apiKey  = document.getElementById('apiKey').value.trim();
      const rankBy  = document.getElementById('rankBy').value;
      const omdbKey = document.getElementById('omdbKey').value.trim();
      const topN    = document.getElementById('topN').value.trim();

      if (!apiKey) {
        const inp = document.getElementById('apiKey');
        inp.classList.add('error'); inp.focus();
        setTimeout(() => inp.classList.remove('error'), 1500);
        return;
      }
      if (rankBy === 'IMDB Rating' && !omdbKey) {
        const inp = document.getElementById('omdbKey');
        inp.classList.add('error'); inp.focus();
        setTimeout(() => inp.classList.remove('error'), 1500);
        return;
      }

      const cfg = { tmdbApiKey: apiKey, rankBy };
      if (omdbKey) cfg.omdbApiKey = omdbKey;
      if (topN)    cfg.topN       = parseInt(topN, 10);

      const encoded     = btoa(JSON.stringify(cfg));
      const base        = window.location.origin;
      const manifestUrl = \`\${base}/\${encoded}/manifest.json\`;
      const stremioUrl  = manifestUrl.replace(/^https?:\\/\\//, 'stremio://');
      document.getElementById('manifest-url').value = manifestUrl;
      document.getElementById('stremio-btn').href   = stremioUrl;
      document.getElementById('result').style.display = 'block';
      document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function copyUrl() {
      const input = document.getElementById('manifest-url');
      input.select();
      try { document.execCommand('copy'); } catch { navigator.clipboard?.writeText(input.value); }
      const btn = document.getElementById('copy-btn');
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    }
  </script>

</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
console.log(`TMDB Complete addon → http://localhost:${PORT}`);
console.log(`Configure           → http://localhost:${PORT}/configure`);
});