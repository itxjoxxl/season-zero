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
const TMDB_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_CATALOGS = [
{ id: 'tmdb.trending_movies', type: 'movie', name: 'Trending Movies', path: '/trending
{ id: 'tmdb.popular_movies', type: 'movie', name: 'Popular Movies', path: '/movie/p
{ id: 'tmdb.top_rated_movies', type: 'movie', name: 'Top Rated Movies', path: '/movie/t
{ id: 'tmdb.upcoming_movies', type: 'movie', name: 'Upcoming Movies', path: '/movie/u
{ id: 'tmdb.nowplaying_movies', type: 'movie', name: 'Now Playing Movies', path: '/movie/n
{ id: 'tmdb.trending_series', type: 'series', name: 'Trending Series', path: '/trendin
{ id: 'tmdb.popular_series', type: 'series', name: 'Popular Series', path: '/tv/popu
{ id: 'tmdb.top_rated_series', type: 'series', name: 'Top Rated Series', path: '/tv/top_
{ id: 'tmdb.airing_today', type: 'series', name: 'Airing Today', path: '/tv/airi
{ id: 'tmdb.on_the_air', type: 'series', name: 'On The Air', path: '/tv/on_t
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
return tmdb('/movie/' + tmdbId, apiKey, { append_to_response: 'external_ids,release_dates,c
async function getSeries(tmdbId, apiKey) {
return tmdb('/tv/' + tmdbId, apiKey, { append_to_response: 'external_ids,content_ratings,cr
}
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
const us = (data.content_ratings && data.content_ratings.results || []).find(r => r.iso_3
return us && us.rating || null;
} catch (e) { return null; }
}
function getMovieCert(data) {
try {
const us = (data.release_dates && data.release_dates.results || []).find(r => r.iso_3166_
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
? ep.vote_average.toFixed(1) + '/10 (' + ep.vote_count.toLocaleString() + ' votes)\n\n
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
const customSeasons = cfg.customSeasons || [];
// NOTE: default catalogs do NOT include 'search' extra — only dedicated search catalogs ha
const allCatalogs = [
...enabledDefaults.map(d => {
const displayName = cfg.catalogNames && cfg.catalogNames[d.id] ? cfg.catalogNames[d.id]
return {
id: d.id, type: d.type, name: displayName,
extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }],
};
}),
...customCatalogs.map(c => ({
id: c.id, type: c.type, name: c.name,
extra: [{ name: 'skip', isRequired: false }],
})),
{ id: 'tmdb.search_movies', type: 'movie', name: 'Search Movies', extra: [{ name: 'sea
{ id: 'tmdb.search_series', type: 'series', name: 'Search Series', extra: [{ name: 'sea
];
if (customSeasons.length > 0) {
allCatalogs.push({ id: 'tmdb.bestof', type: 'series', name: '\u2728 Curated Lists', extra
}
return {
id: 'community.goodtaste-tmdb',
version: '5.1.0',
name: 'GoodTaste',
description: 'Curated episode lists, full TMDB metadata, catalogs, and search.',
logo: 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb7
catalogs: cfg.tmdbApiKey ? allCatalogs : [],
resources: ['catalog', 'meta', 'episodeVideos'],
types: ['movie', 'series'],
idPrefixes: ['tmdb:', 'bestof:', 'tt'],
behaviorHints: { configurable: true, configurationRequired: !cfg.tmdbApiKey },
config: [
{ key: 'tmdbApiKey', type: 'text', title: 'TMDB API Key',
{ key: 'topN', type: 'number', title: 'Top episodes in Best Of season (default: 2
],
};
}
app.get('/manifest.json', (req, res) => res.json(buildManifest()));
app.get('/:config/manifest.json', (req, res) => res.json(buildManifest(req.params.config)));
app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => res.send(configurePage()));
// ─── FEATURED POSTERS (for landing page background) ────────────────────────────
app.get('/api/featured', async function(req, res) {
try {
]);
const [movRes, tvRes] = await Promise.all([
axios.get('https://v3-cinemeta.strem.io/catalog/movie/top.json', { timeout: 8000 }),
axios.get('https://v3-cinemeta.strem.io/catalog/series/top.json', { timeout: 8000 }),
const moviePosters = (movRes.data.metas || []).slice(0, 10).map(m => m.background || m.po
const tvPosters = (tvRes.data.metas || []).slice(0, 10).map(m => m.background || m.po
res.json({ posters: [...moviePosters, ...tvPosters] });
} catch(e) {
res.json({ posters: [] });
}
});
// ─── BEST OF CATALOG ─────────────────────────────────────────────────────────
app.get('/:config/catalog/series/tmdb.bestof.json', async function(req, res) {
const cfg = parseConfig(req.params.config);
const apiKey = cfg.tmdbApiKey;
if (!apiKey) return res.json({ metas: [] });
const customSeasons = cfg.customSeasons || [];
if (!customSeasons.length) return res.json({ metas: [] });
try {
const seriesCache = {};
const metas = (await Promise.all(customSeasons.map(async function(list) {
try {
if (!seriesCache[list.tmdbId]) seriesCache[list.tmdbId] = await getSeries(list.tmdbId
const series = seriesCache[list.tmdbId];
const prefix = list.prefix || '\u2728';
const label = list.label || 'Curated';
const epCount = (list.episodes || []).length;
return {
id: 'bestof:' + list.listId,
type: 'series',
name: prefix + ' ' + label + ' \u2014 ' + (series.name || 'Unknown'),
poster: series.poster_path ? TMDB_IMG_MD + series.poster_path : null,
background: series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
description: label + ': ' + epCount + ' episode' + (epCount !== 1 ? 's' : '') + ' f
releaseInfo: series.first_air_date ? series.first_air_date.substring(0, 4) : imdbRating: series.vote_average ? series.vote_average.toFixed(1) : null,
genres: (series.genres || []).map(g => g.name),
'',
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
const cfg = parseConfig(req.params.config);
const type = req.params.type;
const id = req.params.id;
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
const skip const page = parseInt(extrasMap.skip) || 0;
= Math.floor(skip / 20) + 1;
const genre = extrasMap.genre || null;
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
const customDef = (cfg.customCatalogs || []).find(c => c.id === id);
const catDef = defaultDef || customDef;
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
const raw = Array.isArray(resp.data) ? resp.data : (resp.data && resp.data.items const pageItems = raw.slice(skip, skip + 20);
const metas = [];
for (const item of pageItems) {
const imdbId = item.imdb_id || item.imdbid || null;
const itemTmdbId = item.tmdb_id || item.tmdbid || null;
const mediatype = (item.mediatype || item.type || '').toLowerCase();
const isMovie = mediatype === 'movie' || mediatype === 'movies';
try {
if (itemTmdbId) {
const d = await tmdb((isMovie ? '/movie/' : '/tv/') + itemTmdbId, apiKey);
const meta = isMovie ? movieToMeta(d) : seriesToMeta(d);
if (meta.poster) metas.push(meta);
} else if (imdbId) {
const found = await tmdb('/find/' + imdbId, apiKey, { external_source: 'imdb_id'
const mv = (found.movie_results || [])[0];
const tv = (found.tv_results || [])[0];
if (mv) { const m = movieToMeta(mv); if (m.poster) metas.push(m); }
else if (tv) { const m = seriesToMeta(tv); if (m.poster) metas.push(m); }
? resp
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
const header = rows[0].map(h => String(h || '').trim().toLowerCase());
const constIdx = header.findIndex(h => h === 'const');
const typeIdx = header.findIndex(h => h === 'title type');
if (constIdx === -1) return res.json({ metas: [] });
const ttIds = [];
const isMovieCatalog = catDef.type === 'movie';
for (let i = 1; i < rows.length; i++) {
const cols = rows[i] || [];
const ttId = String(cols[constIdx] || '').trim();
const ttype = typeIdx !== -1 ? normType(cols[typeIdx]) : '';
const isMovieItem = ttype === 'movie' || ttype === 'movies';
const isTvItem = ttype === 'tvseries' || ttype === 'tvminiseries' || ttype === '
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
const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' })
const mv = (found.movie_results || [])[0];
const tv = (found.tv_results || [])[0];
if (mv && isMovieCatalog) { const m = movieToMeta(mv); if (m.poster) metas.push(m
else if (tv && !isMovieCatalog) { const m = seriesToMeta(tv); if (m.poster) metas
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
const d = await tmdb((item.type === 'movie' ? '/movie/' : '/tv/') + item.tmdbId, ap
const meta = item.type === 'movie' ? movieToMeta(d) : seriesToMeta(d);
if (meta.poster) metas.push(meta);
} catch (e) { /* skip */ }
}
return res.json({ metas });
}
let path = catDef.path;
let params = { page };
if (genre) {
path = '/discover/' + (type === 'movie' ? 'movie' : 'tv');
params = { page, with_genres: genre };
if (id.includes('top_rated')) params.sort_by = 'vote_average.desc';
else if (id.includes('popular') || id.includes('trending')) params.sort_by = 'popularit
}
if (customDef && customDef.params) Object.assign(params, customDef.params);
const data = await tmdb(path, apiKey, params);
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
const series = await getSeries(tmdbId, apiKey);
const episodes = await getAllEpisodes(tmdbId, apiKey, series.number_of_seasons || 1);
res.json({
show: { name: series.name, poster: series.poster_path ? TMDB_IMG_MD + series.poster_pat
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
if (!listUrl || !apiKey || !tmdbId) return res.status(400).json({ error: 'url, apiKey, and
tmdbId = String(tmdbId).replace(/^tmdb:/, '').trim();
from U
const listIdMatch = String(listUrl).match(/ls\d+/);
if (!listIdMatch) return res.status(400).json({ error: 'Could not parse IMDB list ID const listId = listIdMatch[0];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko
async function fetchImdbCsvExport() {
const csvUrl = 'https://www.imdb.com/list/' + listId + '/export';
const resp = await axios.get(csvUrl, {
headers: { 'Accept': 'text/csv,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'U
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
headers: { 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent'
timeout: 20000,
validateStatus: (s) => s >= 200 && s < 400,
});
const html = String(resp.data || '');
const hrefMatches = [...html.matchAll(/\/title\/(tt\d+)\//g)].map(m => m[1]);
const urlMatches = [...html.matchAll(/"url"\s*:\s*"https?:\/\/www\.imdb\.com\/title\/(t
return [...new Set([...hrefMatches, ...urlMatches])];
}
try {
let csvText = null;
try { csvText = await fetchImdbCsvExport(); } catch (e) { csvText = null; }
let ttIds = [];
if (csvText) {
const rows = parseCsv(String(csvText));
if (!rows.length) return res.json({ episodes: [], errors: [{ reason: 'Empty CSV export'
const header = rows[0].map(h => String(h || '').trim().toLowerCase());
const constIdx = header.findIndex(h => h === 'const');
const typeIdx = header.findIndex(h => h === 'title type');
if (constIdx === -1) return res.status(400).json({ error: 'Unexpected CSV format for (let i = 1; i < rows.length; i++) {
const cols = rows[i] || [];
const ttId = String(cols[constIdx] || '').trim();
const ttypeNorm = typeIdx !== -1 ? normType(cols[typeIdx]) : '';
if (ttId && ttId.startsWith('tt') && (typeIdx === -1 || ttypeNorm === 'tvepisode')) t
— miss
}
} else {
ttIds = await scrapeImdbListTtIds();
}
ttIds = [...new Set(ttIds)].filter(Boolean);
if (!ttIds.length) return res.json({ episodes: [], errors: [{ reason: 'No IMDb title IDs
});
const results = [], errors = [];
for (const ttId of ttIds) {
try {
const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' const epResults = found.tv_episode_results || [];
if (epResults.length > 0) {
const matches = epResults.filter(ep => String(ep.show_id) === String(tmdbId));
if (matches.length > 0) {
for (const ep of matches) results.push({ season: ep.season_number, episode: ep.ep
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
res.json({ episodes: deduped, errors, skipped: errors.length, totalIds: ttIds.length, mat
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
if (ct.includes('text/html')) throw new Error('IMDB blocked export — list must be public'
const rows = parseCsv(String(resp.data || ''));
if (!rows.length) return res.json({ metas: [], count: 0, name: '' });
const header = rows[0].map(h => String(h || '').trim().toLowerCase());
const constIdx = header.findIndex(h => h === 'const');
const typeIdx = header.findIndex(h => h === 'title type');
const nameIdx = header.findIndex(h => h === 'list name' || h === 'title');
if (constIdx === -1) return res.status(400).json({ error: 'Unexpected CSV format' });
const listName = nameIdx !== -1 && rows[1] ? String(rows[1][nameIdx] || '').trim() const ttIds = [];
for (let i = 1; i < rows.length; i++) {
const cols = rows[i] || [];
const ttId = String(cols[constIdx] || '').trim();
const ttype = typeIdx !== -1 ? normType(cols[typeIdx]) : '';
if (!ttId || !ttId.startsWith('tt')) continue;
if (ttype === 'tvepisode') continue; // skip episodes for catalog
ttIds.push({ ttId, ttype });
: '';
}
const metas = [];
for (const { ttId, ttype } of ttIds.slice(0, 50)) {
try {
const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' const mv = (found.movie_results || [])[0];
const tv = (found.tv_results || [])[0];
if (mv) metas.push(movieToMeta(mv));
else if (tv) metas.push(seriesToMeta(tv));
} catch (e) { /* skip */ }
});
}
const movieCount = metas.filter(m => m.type === 'movie').length;
res.json({ metas, count: ttIds.length, name: listName, suggestedType: movieCount >= metas
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
const raw = Array.isArray(resp.data) ? resp.data : (resp.data && resp.data.items ? if (!raw.length) return res.json({ metas: [], count: 0, name: '' });
resp.d
const listName = (resp.data && resp.data.name) ? resp.data.name : '';
const metas = [];
for (const item of raw.slice(0, 50)) {
const imdbId = item.imdb_id || item.imdbid || null;
const itemTmdbId = item.tmdb_id || item.tmdbid || null;
const mediatype = (item.mediatype || item.type || '').toLowerCase();
const isMovie = mediatype === 'movie' || mediatype === 'movies';
const isTv = mediatype === 'show' || mediatype === 'tv' || mediatype === 'series'
try {
if (itemTmdbId && (isMovie || isTv)) {
const path = isMovie ? '/movie/' + itemTmdbId : '/tv/' + itemTmdbId;
const d = await tmdb(path, apiKey);
metas.push(isMovie ? movieToMeta(d) : seriesToMeta(d));
} else if (imdbId) {
const found = await tmdb('/find/' + imdbId, apiKey, { external_source: 'imdb_id' })
const mv = (found.movie_results || [])[0];
const tv = (found.tv_results || [])[0];
if (mv) metas.push(movieToMeta(mv));
else if (tv) metas.push(seriesToMeta(tv));
}
} catch (e) { /* skip */ }
}
const movieCount = metas.filter(m => m.type === 'movie').length;
res.json({ metas, count: raw.length, name: listName, suggestedType: movieCount >= metas.l
} catch (e) {
console.error('[mdblist-catalog]', e.message);
res.status(500).json({ error: e.message });
}
});
// ─── META ENDPOINTS ───────────────────────────────────────────────────────────
app.get('/:config/meta/movie/:id.json', async function(req, res) {
const cfg = parseConfig(req.params.config);
const id = req.params.id;
if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });
if (!id.startsWith('tmdb:')) return res.json({ meta: null });
try {
const movie = await getMovie(extractId(id), cfg.tmdbApiKey);
const cert = getMovieCert(movie);
const director = (movie.credits && movie.credits.crew || []).find(c => c.job === 'Direc
const cast = (movie.credits && movie.credits.cast || []).slice(0, 8).map(c => c.nam
const trailerKey = (movie.videos && movie.videos.results || []).find(v => v.type === 'Tra
res.json({ meta: {
id, type: 'movie', name: movie.title,
poster: movie.poster_path ? TMDB_IMG_MD + movie.poster_path : null,
background: movie.backdrop_path ? TMDB_IMG_LG + movie.backdrop_path : null,
description: movie.overview,
releaseInfo: runtime: movie.release_date ? movie.release_date.substring(0, 4) : '',
movie.runtime ? movie.runtime + ' min' : null,
genres: (movie.genres || []).map(g => g.name),
imdbRating: movie.vote_average ? movie.vote_average.toFixed(1) : null,
cast, director: director ? director.name : null, certification: cert || null,
trailers: trailerKey ? [{ source: 'yt', type: 'Trailer', ytId: trailerKey.key }] links: movie.external_ids && movie.external_ids.imdb_id
? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' + movie.exter
: [],
}});
} catch (e) {
console.error('[movie meta]', e.message);
res.status(500).json({ err: e.message });
}
});
app.get('/:config/meta/series/:id.json', async function(req, res) {
const cfg = parseConfig(req.params.config);
const id = req.params.id;
if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });
});
if (id.startsWith('bestof:')) {
const listId = id.slice('bestof:'.length);
const customSeasons = cfg.customSeasons || [];
const list = customSeasons.find(l => l.listId === listId);
if (!list || !list.episodes || !list.episodes.length) return res.json({ meta: null try {
const series = await getSeries(list.tmdbId, cfg.tmdbApiKey);
const cert = getSeriesCert(series);
const cast = (series.credits && series.credits.cast || []).slice(0, 8).map(c => c.na
const imdbId = series.external_ids && series.external_ids.imdb_id;
const allEps = await getAllEpisodes(list.tmdbId, cfg.tmdbApiKey, series.number_of_seas
const bestOfEps = [];
for (const ref of list.episodes) {
const ep = allEps.find(e => e.season === ref.season && e.episode === ref.episode);
if (ep) bestOfEps.push(ep);
}
const videos = buildBestOfVideos(bestOfEps, imdbId, list.tmdbId);
const startYear = series.first_air_date ? series.first_air_date.substring(0, 4) : '';
const endYear = series.last_air_date ? series.last_air_date.substring(0, 4) : ''
const releaseInfo = series.status === 'Ended' && endYear ? startYear + '-' + endYear :
const prefix = list.prefix || '\u2728';
const label = list.label || 'Curated';
return res.json({ meta: {
id: 'bestof:' + listId, type: 'series',
name: prefix + ' ' + label + ' \u2014 ' + series.name,
poster: series.poster_path ? TMDB_IMG_MD + series.poster_path : null,
background: series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
description: bestOfEps.length + ' episodes \u2014 ' + label + '\n\n' + (series.overvi
releaseInfo, videos,
runtime: series.episode_run_time && series.episode_run_time[0] ? series.episode
genres: (series.genres || []).map(g => g.name),
imdbRating: series.vote_average ? series.vote_average.toFixed(1) : null,
cast, certification: cert || null,
links: imdbId ? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com
behaviorHints: { defaultVideoId: null },
}});
} catch (e) {
console.error('[bestof meta]', e.message);
return res.status(500).json({ err: e.message });
}
}
if (!id.startsWith('tmdb:')) return res.json({ meta: null });
const tmdbId = extractId(id);
const topN = parseInt(cfg.topN) || 20;
try {
const series = await getSeries(tmdbId, cfg.tmdbApiKey);
const cert = getSeriesCert(series);
const cast = (series.credits && series.credits.cast || []).slice(0, 8).map(c => c.name)
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
votes)
if (cfg.showAutoSeason !== false) {
const bestOfEps = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons
bestOfEps.forEach((ep, i) => {
const rank = i + 1;
const sLabel = String(ep.season).padStart(2, '0');
const eLabel = String(ep.episode).padStart(2, '0');
const ratingLine = ep.vote_average > 0
? ep.vote_average.toFixed(1) + '/10 (' + ep.vote_count.toLocaleString() + ' videos.push({
id: 'tmdb:' + tmdbId + ':0:' + rank,
title: '#' + rank + ' \u2014 S' + sLabel + 'E' + eLabel + ' \u2014 ' + ep.name,
season: 0, episode: rank,
overview: ratingLine + (ep.overview || ''),
thumbnail: ep.still || null,
released: ep.air_date ? new Date(ep.air_date) : null,
});
});
}
const startYear = series.first_air_date ? series.first_air_date.substring(0, 4) : '';
const endYear = series.last_air_date ? series.last_air_date.substring(0, 4) const releaseInfo = series.status === 'Ended' && endYear ? startYear + '-' + endYear : st
: '';
res.json({ meta: {
id, type: 'series', name: series.name,
poster: series.poster_path ? TMDB_IMG_MD + series.poster_path : null,
background: series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
description: series.overview, releaseInfo, videos,
runtime: genres: series.episode_run_time && series.episode_run_time[0] ? series.episode_r
(series.genres || []).map(g => g.name),
imdbRating: cast, certification: cert || null,
series.vote_average ? series.vote_average.toFixed(1) : null,
links: imdbId ? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' +
}});
} catch (e) {
console.error('[series meta]', e.message);
res.status(500).json({ err: e.message });
}
});
// ─── EPISODE VIDEOS ───────────────────────────────────────────────────────────
app.get('/:config/episodeVideos/series/:id.json', async function(req, res) {
const cfg = parseConfig(req.params.config);
const id = req.params.id;
if (!cfg.tmdbApiKey) return res.json({ videos: [] });
const parts = id.split(':');
if (parts[0] !== 'tmdb' || parts.length < 4) return res.json({ videos: [] });
const tmdbId = parts[1];
const season = parseInt(parts[2]);
const episodeNum = parseInt(parts[3]);
if (season !== 0) return res.json({ videos: [] });
try {
const series = await getSeries(tmdbId, cfg.tmdbApiKey);
const imdbId = series.external_ids && series.external_ids.imdb_id || null;
const topN = parseInt(cfg.topN) || 20;
const topEps = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1
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
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&famil
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
--bg: #080808; --surface: #0f0f0f; --surface2: #161616;
--border: #1c1c1c; --border2: #252525; --text: #e8e8e8;
--text-dim: #888; --text-mute: #444; --gold: #f0c040;
--gold-dim: rgba(240,192,64,0.15); --gold-border: rgba(240,192,64,0.25);
--danger: #c0392b; --radius: 12px; --transition: 0.22s cubic-bezier(0.4,0,0.2,1);
}
html { scroll-behavior: smooth; }
body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; fon
/* ── Topbar ── */
.topbar { background: rgba(8,8,8,0.92); backdrop-filter: blur(16px); border-bottom: 1px s
.topbar-brand { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 1.1r
.topbar-brand span { color: var(--gold); }
.topbar-steps { display: flex; align-items: center; gap: 0; margin-left: auto; }
.step-pill { display: flex; align-items: center; gap: 6px; font-size: 0.72rem; font-weigh
.step-pill.active { color: var(--gold); }
.step-pill.done { color: var(--text-dim); }
.step-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border2); tran
.step-pill.active .step-dot { background: var(--gold); animation: pulse-step 2s ease-in-o
.step-pill.done .step-dot { background: var(--text-dim); }
@keyframes pulse-step {
0%, 100% { box-shadow: 0 0 0 0 rgba(240,192,64,0.5); }
50% { box-shadow: 0 0 0 5px rgba(240,192,64,0); }
}
.step-divider { color: var(--text-mute); font-size: 0.6rem; opacity: 0.4; }
@media (max-width: 600px) { .topbar { padding: 0 1rem; } .step-label { display: none; } .
/* ── Main layout ── */
.main { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
@media (max-width: 600px) { .main { padding: 2rem 1rem 5rem; } }
/* ── Pages ── */
.page { display: none; animation: fadeUp 0.35s cubic-bezier(0.4,0,0.2,1); }
.page.active { display: block; }
@keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; tr
/* ── Cards ── */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 18px;
.card-eyebrow { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em; text-transfo
.card-title { font-family: 'Playfair Display', serif; font-size: 1.4rem; font-weight: 700
.card-sub { font-size: 0.82rem; color: var(--text-dim); line-height: 1.6; margin-bottom:
/* ── Hero ── */
.hero-wrap { position: relative; overflow: hidden; border-radius: 18px; margin-bottom: 1r
.hero-bg { position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: no
.hero-bg-track { display: flex; gap: 6px; height: 100%; animation: bgscroll 40s linear in
@keyframes bgscroll { from { transform: translateX(0); } to { transform: translateX(-50%)
.hero-bg-col { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.hero-bg-img { width: 120px; height: 80px; object-fit: cover; border-radius: 4px; flex-sh
.hero-bg-overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, r
.hero-content { position: relative; z-index: 2; text-align: center; padding: 3rem 2rem 2.
.hero-logo { font-family: 'Playfair Display', serif; font-size: 3.5rem; font-weight: 700;
.hero-logo span { color: var(--gold); }
.hero-tagline { font-size: 0.85rem; color: rgba(255,255,255,0.55); margin-bottom: 2.5rem;
.hero-features { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; text-align: lef
.hero-feat { background: rgba(15,15,15,0.7); border: 1px solid rgba(255,255,255,0.07); bo
.hero-feat strong { display: flex; align-items: center; gap: 6px; color: rgba(255,255,255
.feat-badge { font-size: 0.55rem; font-weight: 700; letter-spacing: 0.08em; text-transfor
@media (max-width: 480px) { .hero-features { grid-template-columns: 1fr; } .hero-logo { f
/* ── Fields ── */
.field { margin-bottom: 1.25rem; }
label { display: block; font-size: 0.7rem; font-weight: 600; color: var(--text-dim); marg
input[type=text], input[type=number], input[type=password], textarea, select { width: 100
input:focus, select:focus, textarea:focus { border-color: var(--gold); box-shadow: 0 0 0
textarea { resize: vertical; min-height: 80px; line-height: 1.5; }
select { cursor: pointer; }
input.error { border-color: var(--danger) !important; animation: shake 0.3s; }
@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{t
.hint { font-size: 0.72rem; color: var(--text-mute); margin-top: 6px; }
.hint a { color: var(--gold); text-decoration: none; }
/* ── Buttons ── */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padd
.btn-primary { background: var(--gold); color: #000; }
.btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
.btn-ghost { background: transparent; border: 1px solid var(--border2); color: var(--text
.btn-ghost:hover { border-color: var(--text-dim); color: var(--text); }
.btn-danger { background: rgba(192,57,43,0.15); border: 1px solid rgba(192,57,43,0.3); co
.btn-danger:hover { background: rgba(192,57,43,0.25); }
.btn-install { width: 100%; background: var(--gold); color: #000; font-size: 1rem; .btn-install:hover { opacity: 0.9; transform: translateY(-2px); box-shadow: 0 8px 32px rg
.btn-sm { padding: 7px 14px; font-size: 0.78rem; }
.btn-lg { padding: 13px 28px; font-size: 0.95rem; }
font-w
/* ── Toggle ── */
.toggle { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle-slider { position: absolute; inset: 0; background: var(--border2); border-radius:
.toggle-slider::before { content: ''; position: absolute; width: 16px; height: 16px; left
.toggle input:checked + .toggle-slider { background: var(--gold); }
.toggle input:checked + .toggle-slider::before { transform: translateX(18px); }
/* ── Section headers ── */
.section-header { display: flex; align-items: center; justify-content: space-between; mar
.section-label { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em; text-transf
/* ── Search ── */
.search-wrap { position: relative; }
.search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); col
.search-wrap input { padding-left: 42px; }
.search-results { margin-top: 8px; display: none; }
.search-results.visible { display: block; }
.search-result-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px;
.search-result-item:hover { background: var(--surface2); border-color: var(--border); }
.search-poster { width: 34px; height: 50px; border-radius: 5px; object-fit: cover; backgr
.search-name { font-size: 0.87rem; font-weight: 600; color: var(--text); }
.search-meta { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }
/* ── Show cards ── */
.show-card { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; marg
.show-card:hover { border-color: var(--border2); }
.show-card-header { display: flex; align-items: center; gap: 14px; padding: 14px 16px; }
.show-poster { width: 32px; height: 48px; border-radius: 5px; object-fit: cover; backgrou
.show-card-info { flex: 1; min-width: 0; }
.show-card-name { font-size: 0.88rem; font-weight: 600; color: #fff; white-space: nowrap;
.show-card-sub { font-size: 0.71rem; color: var(--text-mute); margin-top: 2px; }
.show-card-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.ep-count-badge { font-size: 0.7rem; color: var(--text-mute); font-family: 'DM Mono', mon
.ep-count-badge.has-eps { color: var(--gold); border-color: var(--gold-border); backgroun
.show-ep-body { display: none; border-top: 1px solid var(--border); }
.show-card.expanded .show-ep-body { display: block; }
.show-ep-inner { padding: 12px 16px 16px; }
.show-rename-row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
.show-rename-prefix { max-width: 70px; font-size: 1.1rem; text-align: center; padding: 9p
.show-rename-label { flex: 1; }
/* ── Add tabs ── */
.add-tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--surf
.add-tab { flex: 1; padding: 9px 8px; font-size: 0.73rem; font-weight: 600; text-align: c
.add-tab.active { color: var(--gold); border-bottom-color: var(--gold); }
.add-tab:hover:not(.active) { color: var(--text-dim); }
.add-panel { display: none; padding: 14px; background: var(--surface); }
.add-panel.active { display: block; }
.paste-hint { font-size: 0.72rem; color: var(--text-mute); margin-bottom: 8px; line-heigh
.paste-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap
.paste-status { font-size: 0.73rem; }
.paste-status.ok { color: #4caf82; }
.paste-status.err { color: #e05252; }
.import-row { display: flex; gap: 8px; }
.import-row input { flex: 1; font-size: 0.82rem; }
.import-status { font-size: 0.73rem; margin-top: 6px; color: var(--text-mute); min-height
.import-status.ok { color: #4caf82; }
.import-status.err { color: #e05252; }
/* ── Episode list ── */
.ep-list { list-style: none; }
.ep-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radiu
.ep-item.dragging { opacity: 0.4; cursor: grabbing; }
.ep-item.drag-over { border-color: var(--gold); background: var(--gold-dim); }
.ep-rank { width: 22px; text-align: center; flex-shrink: 0; font-size: 0.68rem; color: va
.ep-drag { color: var(--text-mute); flex-shrink: 0; font-size: 0.85rem; cursor: grab; pad
.ep-thumb { width: 56px; height: 32px; border-radius: 4px; object-fit: cover; flex-shrink
.ep-info { flex: 1; min-width: 0; }
.ep-label { font-size: 0.79rem; font-weight: 600; color: var(--text); white-space: .ep-sublabel { font-size: 0.67rem; color: var(--text-mute); margin-top: 2px; }
.ep-rating { font-size: 0.7rem; color: var(--gold); font-family: 'DM Mono', monospace; fl
.ep-del { flex-shrink: 0; color: var(--text-mute); cursor: pointer; font-size: 0.9rem; pa
.ep-del:hover { color: #e05252; }
.ep-list-empty { font-size: 0.8rem; color: var(--text-mute); padding: 10px 0; }
nowrap
/* ── Catalog rows ── */
.catalog-row { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-
.catalog-row-info { flex: 1; min-width: 0; }
.catalog-row-name-input { background: transparent; border: none; border-bottom: 1px solid
.catalog-row-name-input:focus { outline: none; border-bottom-color: var(--gold); box-shad
.catalog-row-type { font-size: 0.7rem; color: var(--text-mute); margin-top: 2px; }
.catalog-section-label { font-size: 0.68rem; font-weight: 600; color: var(--text-mute); t
.catalog-section-header { display: flex; align-items: center; justify-content: space-betw
.catalog-section-header:hover .catalog-section-label { color: var(--text-dim); }
.catalog-collapse-body { overflow: hidden; transition: max-height 0.3s ease; }
.catalog-collapse-body.collapsed { max-height: 0; }
.catalog-chevron { color: var(--text-mute); font-size: 0.7rem; transition: transform 0.2s
.catalog-section-header.collapsed .catalog-chevron { transform: rotate(-90deg); }
.custom-catalog-form { background: var(--surface2); border: 1px solid var(--border2); bor
.custom-catalog-form.open { display: block; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 480px) { .form-row { grid-template-columns: 1fr; } }
.custom-catalog-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
.custom-catalog-item-info { flex: 1; }
.custom-catalog-item-name { font-size: 0.86rem; font-weight: 600; color: var(--text); }
.custom-catalog-item-sub { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; f
/* ── Handpicked catalog ── */
.handpicked-search-results { max-height: 240px; overflow-y: auto; margin-top: 8px; }
.handpicked-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; bord
.handpicked-item:hover { background: var(--surface2); }
.handpicked-item img { width: 30px; height: 44px; border-radius: 4px; object-fit: cover;
.handpicked-item-info { flex: 1; min-width: 0; }
.handpicked-item-name { font-size: 0.83rem; font-weight: 600; color: var(--text); white-s
.handpicked-item-meta { font-size: 0.7rem; color: var(--text-mute); margin-top: 1px; }
.handpicked-added { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; min-height
.handpicked-tag { display: inline-flex; align-items: center; gap: 5px; background: var(--
.handpicked-tag button { background: none; border: none; color: var(--gold); cursor: poin
/* ── Season Zero card (compact) ── */
.szero-card { background: rgba(240,192,64,0.04); border: 1px solid rgba(240,192,64,0.15);
.szero-header { display: flex; align-items: center; gap: 10px; justify-content: space-bet
.szero-header-left { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0
.szero-title-row { display: flex; align-items: center; gap: 7px; }
.szero-title { font-size: 0.87rem; font-weight: 600; color: var(--text); }
.beta-badge { display: inline-flex; align-items: center; background: rgba(240,192,64,0.1)
.szero-short-desc { font-size: 0.76rem; color: var(--text-mute); margin-top: 2px; }
.szero-expand { font-size: 0.72rem; color: var(--text-mute); cursor: pointer; white-space
.szero-expand:hover { color: var(--gold); }
.szero-body { margin-top: 14px; display: none; border-top: 1px solid rgba(240,192,64,0.1)
.szero-card.expanded .szero-body { display: block; }
.szero-full-desc { font-size: 0.78rem; color: var(--text-mute); line-height: 1.6; margin-
/* ── Modal ── */
.modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8);
.modal-backdrop.open { display: flex; }
.modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 20p
@keyframes modalIn { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { o
.modal-header { padding: 1.4rem 1.6rem 1rem; border-bottom: 1px solid var(--border); disp
.modal-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; backgro
.modal-title { font-size: 1rem; font-weight: 700; color: #fff; }
.modal-sub { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }
.modal-close { margin-left: auto; color: var(--text-mute); cursor: pointer; font-size: 1
.modal-close:hover { color: var(--text); }
.modal-filter { padding: 12px 1.6rem; border-bottom: 1px solid var(--border); display: fl
.season-btn { padding: 4px 12px; border-radius: 20px; font-size: 0.72rem; font-weight: 60
.season-btn.active { background: var(--gold); border-color: var(--gold); color: #000; }
.modal-ep-list { flex: 1; overflow-y: auto; padding: 10px 1.6rem; }
.modal-ep-item { display: flex; align-items: center; gap: 10px; padding: 9px 10px; .modal-ep-item:hover { background: var(--surface2); }
border
.modal-ep-item.selected { border-color: var(--gold); background: var(--gold-dim); }
.modal-ep-thumb { width: 64px; height: 36px; border-radius: 5px; object-fit: cover; backg
.modal-ep-info { flex: 1; min-width: 0; }
.modal-ep-name { font-size: 0.82rem; font-weight: 600; color: var(--text); white-space:
.modal-ep-meta { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; }
.modal-ep-check { width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(
.modal-ep-item.selected .modal-ep-check { background: var(--gold); border-color: var(--go
.modal-footer { padding: 1rem 1.6rem; border-top: 1px solid var(--border); display: flex;
.modal-sel-label { font-size: 0.8rem; color: var(--text-dim); }
paddin
font-s
/* ── Install page ── */
.install-hero { text-align: center; padding: 1rem 0 2rem; }
.install-hero-title { font-family: 'Playfair Display', serif; font-size: 2rem; font-weigh
.install-hero-title span { color: var(--gold); }
.install-hero-sub { font-size: 0.83rem; color: var(--text-dim); }
.summary-row { display: flex; align-items: center; justify-content: space-between; .summary-label { color: var(--text-dim); }
.summary-value { color: #fff; font-weight: 600; font-family: 'DM Mono', monospace; .summary-value.accent { color: var(--gold); }
.ep-parade { display: flex; gap: 6px; overflow: hidden; margin: 1.5rem 0; mask-image: lin
.ep-parade-track { display: flex; gap: 6px; animation: scroll 20s linear infinite; @keyframes scroll { from { transform: translateX(0); } to { transform: translateX(-50%);
.parade-thumb { width: 80px; height: 45px; border-radius: 6px; object-fit: cover; flex-sh
.or-divider { text-align: center; font-size: 0.72rem; color: var(--text-mute); margin: 14
.copy-row { display: flex; gap: 8px; }
.copy-row input { flex: 1; font-size: 0.72rem; color: var(--text-mute); padding: 10px 12p
.btn-copy { flex-shrink: 0; padding: 10px 18px; background: var(--surface2); border: 1px
.btn-copy:hover { border-color: var(--gold); color: var(--gold); }
.btn-copy.copied { border-color: #4caf82; color: #4caf82; }
flex-s
/* ── Utilities ── */
.nav-row { display: flex; justify-content: space-between; align-items: center; margin-top
.spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(0,0,0
.spinner-light { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba
@keyframes spin { to { transform: rotate(360deg); } }
.loading-state { display: flex; align-items: center; justify-content: center; gap: .empty-state { text-align: center; padding: 2.5rem 1rem; color: var(--text-mute); font-si
.flex-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mt-1 { margin-top: 8px; } .mt-2 { margin-top: 14px; }
10px;
`;
const clientJS = [
"var DEFAULT_CATALOGS = " + defaultCatalogsJson + ";",
"var state = { apiKey:'', topN:20, showAutoSeason:false, customSeasons:[], catalogEnabled
"var modalData = { listId:null, tmdbId:null, allEpisodes:[], filteredSeason:'all', "var genreCache = { movie:null, tv:null };",
"var handpickedItems = [];",
select
"var TOTAL_PAGES = 4;",
"",
"function uid() { return Math.random().toString(36).slice(2)+Date.now().toString(36); }",
"",
"function goTo(n) {",
" document.querySelectorAll('.page').forEach(function(p,i){ p.classList.toggle('active',
" document.querySelectorAll('[id^=step-]').forEach(function(el) {",
" var num=parseInt(el.id.replace('step-',''));",
" el.classList.remove('active','done');",
" if(num===n) el.classList.add('active');",
" else if(num<n) el.classList.add('done');",
" });",
" if(n===TOTAL_PAGES) buildInstallPage();",
" window.scrollTo({top:0,behavior:'smooth'});",
"}",
"",
// ── API key validation ──
"async function validateApiKey() {",
" var input=document.getElementById('apiKey');",
" var key=input.value.trim();",
" var btn=document.getElementById('btn-validate');",
" if(!key){ flashError(input); return; }",
" btn.innerHTML='<span class=\"spinner\"></span> Checking...'; btn.disabled=true;",
" try {",
" var r=await fetch('/api/search?q=test&apiKey='+encodeURIComponent(key));",
" var d=await r.json();",
" if(d.error) throw new Error(d.error);",
" state.apiKey=key;",
" renderDefaultCatalogs();",
" goTo(2);",
" } catch(e) {",
" flashError(input); input.placeholder='Invalid key — try again';",
" } finally { btn.innerHTML='Continue &rarr;'; btn.disabled=false; }",
"}",
"function flashError(el){ el.classList.add('error'); el.focus(); setTimeout(function(){ e
"",
// ── Tab switching ──
"function switchAddTab(listId,tab) {",
" ['picker','imdb','paste'].forEach(function(t){",
" var btn=document.getElementById('add-tab-'+t+'-'+listId);",
" var panel=document.getElementById('add-panel-'+t+'-'+listId);",
" if(btn) btn.classList.toggle('active',t===tab);",
" if(panel) panel.classList.toggle('active',t===tab);",
" });",
"}",
"",
// ── Paste episodes ──
"function parsePasteEpisodes(text) {",
" var results=[];",
" var re=/[Ss](\\d{1,3})[Ee](\\d{1,3})|(?:^|\\D)(\\d{1,2})[Xx](\\d{1,3})(?:\\D|$)/gm; va
" while((m=re.exec(text))!==null){",
" var s=parseInt(m[1]||m[3]); var e=parseInt(m[2]||m[4]);",
" if(!isNaN(s)&&!isNaN(e)&&s>0&&e>0) results.push({season:s,episode:e});",
" }",
" var seen=new Set();",
" return results.filter(function(ep){ var k=ep.season+':'+ep.episode; if(seen.has(k)) re
"}",
"function applyPaste(listId) {",
" var ta=document.getElementById('paste-input-'+listId);",
" var st=document.getElementById('paste-status-'+listId);",
" if(!ta||!st) return;",
" var text=ta.value.trim();",
" if(!text){ st.textContent='Paste some episode codes first'; st.className='paste-status
" var parsed=parsePasteEpisodes(text);",
" if(!parsed.length){ st.textContent='No codes found. Use S01E01 or 1x01 format.'; st.cl
" var list=getList(listId); if(!list) return;",
" var allEps=(modalData.tmdbId===list.tmdbId)?modalData.allEpisodes:[];",
" var existingKeys=new Set(list.episodes.map(function(e){ return e.season+':'+e.episode;
" var added=0;",
" for(var i=0;i<parsed.length;i++){",
" var ref=parsed[i]; var key=ref.season+':'+ref.episode;",
" if(!existingKeys.has(key)){ existingKeys.add(key); var full=allEps.find(function(e){
" }",
" st.textContent='Added '+added+' of '+parsed.length+' episode'+(parsed.length!==1?'s':'
" ta.value=''; renderListEpisodes(listId); updateEpCount(listId);",
"}",
"",
// ── Default catalog UI ──
"function renderDefaultCatalogs() {",
" ['movie','series'].forEach(function(type){",
" var el=document.getElementById('catalog-defaults-'+type);",
" var cats=DEFAULT_CATALOGS.filter(function(c){ return c.type===type; });",
" el.innerHTML=cats.map(function(c){",
" var checked=state.catalogEnabled[c.id]!==undefined?state.catalogEnabled[c.id]:c.en
" var displayName=state.catalogNames[c.id]||c.name;",
" return '<div class=\"catalog-row\">'+",
" '<div class=\"catalog-row-info\">'+",
" '<input class=\"catalog-row-name-input\" type=\"text\" value=\"'+esc(displayNa
" '<div class=\"catalog-row-type\">'+c.type+'</div>'+",
" '</div>'+",
" '<label class=\"toggle\"><input type=\"checkbox\" '+(checked?'checked':'')+' onc
" '</div>';",
" }).join('');",
" });",
"}",
"function setCatalogEnabled(id,val){ state.catalogEnabled[id]=val; }",
"function setCatalogName(id,val){ state.catalogNames[id]=val; }",
"",
"function toggleCatalogSection(type) {",
" var body=document.getElementById('cat-section-body-'+type);",
" var hdr=document.getElementById('cat-section-hdr-'+type);",
" if(!body||!hdr) return;",
" var collapsed=body.classList.toggle('collapsed');",
" hdr.classList.toggle('collapsed',collapsed);",
"}",
"",
// ── Custom catalog (TMDB Discover) ──
"function toggleCustomCatalogForm(type) {",
" var form=document.getElementById('custom-catalog-form-'+type);",
" if(!form) return;",
" form.classList.toggle('open');",
" if(form.classList.contains('open')) loadGenresForCustom(type);",
"}",
"async function loadGenresForCustom(type) {",
" var tt=(type==='series'?'tv':'movie');",
" if(genreCache[tt]){ populateGenreSelect(genreCache[tt],type); return; }",
" try {",
" var r=await fetch('/api/genres?apiKey='+encodeURIComponent(state.apiKey)+'&type='+tt
" var d=await r.json();",
" genreCache[tt]=d.genres||[]; populateGenreSelect(genreCache[tt],type);",
" } catch(e){}",
"}",
"function populateGenreSelect(genres,type) {",
" var sel=document.getElementById('cc-genre-'+type);",
" if(!sel) return;",
" sel.innerHTML='<option value=\"\">Any Genre</option>'+genres.map(function(g){ return '
"}",
"function addCustomCatalog(type) {",
" var name=document.getElementById('cc-name-'+type).value.trim();",
" var genre=document.getElementById('cc-genre-'+type).value;",
" var sort=document.getElementById('cc-sort-'+type).value;",
" if(!name){ var n=document.getElementById('cc-name-'+type); n.classList.add('error'); s
" var tt=(type==='series'?'tv':'movie');",
" var params={sort_by:sort};",
" if(genre) params.with_genres=genre;",
" state.customCatalogs.push({id:'custom.'+Date.now(),name:name,type:type,path:'/discover
" document.getElementById('cc-name-'+type).value='';",
" document.getElementById('custom-catalog-form-'+type).classList.remove('open');",
" renderCustomCatalogsList();",
"}",
"function removeCustomCatalog(id){ state.customCatalogs=state.customCatalogs.filter(funct
"function renderCustomCatalogsList() {",
" var el=document.getElementById('custom-catalogs-list');",
" if(!state.customCatalogs.length){ el.innerHTML='<div class=\"empty-state\">No custom c
" var sortLabels={'popularity.desc':'Popular','vote_average.desc':'Top Rated','release_d
" el.innerHTML=state.customCatalogs.map(function(c){",
" var srcLabel=c.path==='_mdblist_'?'MDBList':c.path==='_imdb_'?'IMDB List':c.path==='
" var gp=c.params&&c.params.with_genres?' \u00b7 Genre '+c.params.with_genres:'';",
" return '<div class=\"custom-catalog-item\"><div class=\"custom-catalog-item-info\"><
" }).join('');",
"}",
"",
// ── MDBList catalog ──
"var mdbCatalogPreviewData=null;",
"async function previewMdbCatalog(type) {",
" var input=document.getElementById('mdb-cat-url-'+type);",
" var status=document.getElementById('mdb-cat-status-'+type);",
" var btn=document.getElementById('mdb-cat-btn-'+type);",
" var preview=document.getElementById('mdb-cat-preview-'+type);",
" var url=(input?input.value:'').trim();",
" if(!url){ status.textContent='Please enter an MDBList URL'; status.style.color='var(--
" btn.disabled=true; btn.innerHTML='<span class=\"spinner-light\"></span>';",
" status.textContent='Fetching list\u2026'; status.style.color='var(--text-mute)';",
" preview.style.display='none'; mdbCatalogPreviewData=null;",
" try {",
" var r=await fetch('/api/mdblist-catalog?url='+encodeURIComponent(url)+'&apiKey='+enc
" var d=await r.json();",
" if(d.error) throw new Error(d.error);",
" if(!d.metas||!d.metas.length) throw new Error('No movies or shows found.');",
" mdbCatalogPreviewData={url:url,metas:d.metas,name:d.name,count:d.count,type:type};",
" var nameInput=document.getElementById('mdb-cat-name-'+type);",
" if(d.name) nameInput.value=d.name;",
" var thumbs=d.metas.slice(0,8).map(function(m){ return m.poster?'<img src=\"'+m.poste
" document.getElementById('mdb-cat-thumbs-'+type).innerHTML=thumbs;",
" status.textContent=d.count+' item'+(d.count!==1?'s':'')+' found'+(d.name?' \u2014 '+
" status.style.color='var(--gold)'; preview.style.display='block';",
" } catch(e){ status.textContent='Error: '+e.message; status.style.color='#e05252'; }",
" finally{ btn.disabled=false; btn.textContent='Preview'; }",
"}",
"function addMdbCatalog(type) {",
" if(!mdbCatalogPreviewData||mdbCatalogPreviewData.type!==type) return;",
" var name=document.getElementById('mdb-cat-name-'+type).value.trim()||'MDBList';",
" state.customCatalogs.push({id:'mdblist.'+Date.now(),name:name,type:type,path:'_mdblist
" document.getElementById('mdb-cat-url-'+type).value='';",
" document.getElementById('mdb-cat-preview-'+type).style.display='none';",
" document.getElementById('mdb-cat-status-'+type).textContent='\u2713 Added \"'+name+'\"
" document.getElementById('mdb-cat-status-'+type).style.color='var(--gold)';",
" mdbCatalogPreviewData=null; renderCustomCatalogsList();",
"}",
"",
// ── IMDB catalog ──
"var imdbCatalogPreviewData=null;",
"async function previewImdbCatalog(type) {",
" var input=document.getElementById('imdb-cat-url-'+type);",
" var status=document.getElementById('imdb-cat-status-'+type);",
" var btn=document.getElementById('imdb-cat-btn-'+type);",
" var preview=document.getElementById('imdb-cat-preview-'+type);",
" var url=(input?input.value:'').trim();",
" if(!url){ status.textContent='Please enter an IMDB list URL'; status.style.color='var(
" btn.disabled=true; btn.innerHTML='<span class=\"spinner-light\"></span>';",
" status.textContent='Fetching list\u2026'; status.style.color='var(--text-mute)';",
" preview.style.display='none'; imdbCatalogPreviewData=null;",
" try {",
" var r=await fetch('/api/imdb-catalog?url='+encodeURIComponent(url)+'&apiKey='+encode
" var d=await r.json();",
" if(d.error) throw new Error(d.error);",
" if(!d.metas||!d.metas.length) throw new Error('No titles resolved from this list.');
" imdbCatalogPreviewData={url:url,metas:d.metas,name:d.name,count:d.count,type:type};"
" var nameInput=document.getElementById('imdb-cat-name-'+type);",
" if(d.name) nameInput.value=d.name;",
" var thumbs=d.metas.slice(0,8).map(function(m){ return m.poster?'<img src=\"'+m.poste
" document.getElementById('imdb-cat-thumbs-'+type).innerHTML=thumbs;",
" status.textContent=d.count+' titles found'+(d.name?' \u2014 '+d.name:'');",
" status.style.color='var(--gold)'; preview.style.display='block';",
" } catch(e){ status.textContent='Error: '+e.message; status.style.color='#e05252'; }",
" finally{ btn.disabled=false; btn.textContent='Preview'; }",
"}",
"function addImdbCatalog(type) {",
" if(!imdbCatalogPreviewData||imdbCatalogPreviewData.type!==type) return;",
" var name=document.getElementById('imdb-cat-name-'+type).value.trim()||'IMDB List';",
" state.customCatalogs.push({id:'imdb.'+Date.now(),name:name,type:type,path:'_imdb_',imd
" document.getElementById('imdb-cat-url-'+type).value='';",
" document.getElementById('imdb-cat-preview-'+type).style.display='none';",
" document.getElementById('imdb-cat-status-'+type).textContent='\u2713 Added \"'+name+'\
" document.getElementById('imdb-cat-status-'+type).style.color='var(--gold)';",
" imdbCatalogPreviewData=null; renderCustomCatalogsList();",
"}",
"",
// ── Handpicked catalog ──
"var handpickedSearchTimer;",
"function debounceHandpickedSearch(q,type) {",
" clearTimeout(handpickedSearchTimer);",
" if(!q.trim()){ document.getElementById('handpicked-results-'+type).innerHTML=''; retur
" handpickedSearchTimer=setTimeout(function(){ doHandpickedSearch(q,type); },350);",
"}",
"async function doHandpickedSearch(q,type) {",
" var box=document.getElementById('handpicked-results-'+type);",
" box.innerHTML='<div class=\"loading-state\" style=\"padding:8px\"><div class=\"spinner
" try {",
" var r=await fetch('/api/tmdb-search?q='+encodeURIComponent(q)+'&apiKey='+encodeURICo
" var d=await r.json();",
" if(!d.results||!d.results.length){ box.innerHTML='<p style=\"padding:8px;font-size:0
" var filtered=d.results.filter(function(s){ return s.type===(type==='series'?'series'
" if(!filtered.length){ box.innerHTML='<p style=\"padding:8px;font-size:0.78rem;color:
" box.innerHTML=filtered.map(function(s){",
" var img=s.poster?'<img src=\"'+s.poster+'\" alt=\"\" loading=\"lazy\"/>' : '<img s
" return '<div class=\"handpicked-item\" onclick=\"addHandpickedItem('+s.id+',\\''+
" }).join('');",
" } catch(e){ box.innerHTML='<p style=\"padding:8px;color:var(--text-mute)\">Error.</p>'
"}",
"var handpickedByType={'movie':[],'series':[]};",
"function addHandpickedItem(tmdbId,name,poster,type) {",
" if(!handpickedByType[type]) handpickedByType[type]=[];",
" if(handpickedByType[type].find(function(i){ return i.tmdbId===String(tmdbId); })) retu
" handpickedByType[type].push({tmdbId:String(tmdbId),name:name,poster:poster,type:type})
" renderHandpickedTags(type);",
"}",
"function removeHandpickedItem(tmdbId,type) {",
" handpickedByType[type]=handpickedByType[type].filter(function(i){ return i.tmdbId!==St
" renderHandpickedTags(type);",
"}",
"function renderHandpickedTags(type) {",
" var el=document.getElementById('handpicked-tags-'+type);",
" if(!el) return;",
" var items=handpickedByType[type]||[];",
" el.innerHTML=items.map(function(item){ return '<span class=\"handpicked-tag\">'+esc(it
"}",
"function addHandpickedCatalog(type) {",
" var name=document.getElementById('handpicked-name-'+type).value.trim();",
" var items=handpickedByType[type]||[];",
" if(!name){ var n=document.getElementById('handpicked-name-'+type); n.classList.add('er
" if(!items.length){ alert('Search and add some titles first.'); return; }",
" state.customCatalogs.push({id:'handpicked.'+Date.now(),name:name,type:type,path:'_hand
" document.getElementById('handpicked-name-'+type).value='';",
" handpickedByType[type]=[];",
" renderHandpickedTags(type);",
" document.getElementById('handpicked-search-'+type).value='';",
" document.getElementById('handpicked-results-'+type).innerHTML='';",
" renderCustomCatalogsList();",
"}",
"",
// ── Episode lists ──
"function getList(listId){ return state.customSeasons.find(function(l){ return l.listId==
"function updateListMeta(listId,field,value) {",
" var list=getList(listId); if(list) list[field]=value;",
" var nameEl=document.getElementById('show-name-display-'+listId);",
" if(nameEl&&list) nameEl.textContent=(list.prefix||'\u2728')+' '+(list.label||'Best Of'
"}",
"function removeList(listId){ state.customSeasons=state.customSeasons.filter(function(l){
"function removeEp(listId,idx){ var list=getList(listId); if(!list) return; list.episodes
"function toggleShowCard(listId){ var card=document.getElementById('show-'+listId); if(ca
"function updateEpCount(listId) {",
" var list=getList(listId); if(!list) return;",
" var badge=document.getElementById('ep-count-'+listId);",
" if(badge){ badge.textContent=list.episodes.length+' ep'+(list.episodes.length!==1?'s':
"}",
"",
"function renderListEpisodes(listId) {",
" var list=getList(listId); if(!list) return;",
" var el=document.getElementById('eplist-'+listId); if(!el) return;",
" if(!list.episodes.length){ el.innerHTML='<li class=\"ep-list-empty\">No episodes yet.
" el.innerHTML=list.episodes.map(function(ep,i){",
" var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'0');
" var th=ep.still?'<img class=\"ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading=\"laz
" return '<li class=\"ep-item\" draggable=\"true\" data-lid=\"'+listId+'\" data-idx=\"
" }).join('');",
" initDragSort(listId);",
"}",
"",
"function renderCustomSeasonsList() {",
" var el=document.getElementById('custom-seasons-list');",
" if(!state.customSeasons.length){ el.innerHTML='<div class=\"empty-state\">No shows yet
" el.innerHTML=state.customSeasons.map(function(list){",
" var tid=list.listId;",
" var ph=list.tmdbPoster?'<img class=\"show-poster\" src=\"'+list.tmdbPoster+'\" alt=\
" var displayName=(list.prefix||'\u2728')+' '+(list.label||'Best Of')+' \u2014 '+list.
" var epItems=list.episodes.length?",
" list.episodes.map(function(ep,i){",
" var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'
" var th=ep.still?'<img class=\"ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading=\
" return '<li class=\"ep-item\" draggable=\"true\" data-lid=\"'+tid+'\" data-idx=\
" }).join(''):",
" '<li class=\"ep-list-empty\">No episodes yet. Use the tabs above to add some.</li>
" var hasCnt=list.episodes.length>0;",
" return '<div class=\"show-card\" id=\"show-'+tid+'\">'+",
" '<div class=\"show-card-header\">'+ph+",
" '<div class=\"show-card-info\"><div class=\"show-card-name\" id=\"show-name-disp
" '<div class=\"show-card-actions\"><span class=\"ep-count-badge'+(hasCnt?' " '<button class=\"btn btn-ghost btn-sm\" onclick=\"toggleShowCard(\\''+ tid +'\
has-ep
placeh
" '</div>'+",
" '<div class=\"show-ep-body\">'+",
" '<div style=\"padding:14px 16px 0;\"><div class=\"show-rename-row\">'+",
" '<input class=\"show-rename-prefix\" type=\"text\" value=\"'+esc(list.prefix||
" '<input class=\"show-rename-label\" type=\"text\" value=\"'+esc(list.label||'B
" '<button class=\"btn btn-danger btn-sm\" onclick=\"removeList(\\''+ tid +'\\')
" '</div></div>'+",
" '<div class=\"add-tabs\">'+",
" '<button class=\"add-tab active\" id=\"add-tab-picker-'+tid+'\" onclick=\"swit
" '<button class=\"add-tab\" id=\"add-tab-imdb-'+tid+'\" onclick=\"switchAddTab(
" '<button class=\"add-tab\" id=\"add-tab-paste-'+tid+'\" onclick=\"switchAddTab
" '</div>'+",
" '<div class=\"add-panel active\" id=\"add-panel-picker-'+tid+'\"><button class=\
" '<div class=\"add-panel\" id=\"add-panel-imdb-'+tid+'\">'+",
" '<div class=\"import-row\"><input type=\"text\" id=\"imdb-url-'+tid+'\" " '<div class=\"import-status\" id=\"imdb-status-'+tid+'\"></div>'+",
" '</div>'+",
" '<div class=\"add-panel\" id=\"add-panel-paste-'+tid+'\">'+",
" '<p class=\"paste-hint\">Accepts S01E01, s1e1, 1x01 and similar formats.</p>'+
" '<textarea id=\"paste-input-'+tid+'\" placeholder=\"S01E01\nS01E05\nS02E03\"><
" '<div class=\"paste-actions\"><button class=\"btn btn-primary btn-sm\" onclick
" '</div>'+",
" '<div style=\"padding:0 16px 16px;\"><ul class=\"ep-list mt-2\" id=\"eplist-'+ti
" '</div>'+",
" '</div>';",
" }).join('');",
" state.customSeasons.forEach(function(list){ initDragSort(list.listId); });",
"}",
"",
// ── Drag sort (mouse + touch) ──
"function initDragSort(listId) {",
" var listEl=document.getElementById('eplist-'+listId); if(!listEl) return;",
" var dragIdx=null;",
" function getItemAtY(y) {",
" var items=Array.from(listEl.querySelectorAll('.ep-item'));",
" for(var i=0;i<items.length;i++){",
" var rect=items[i].getBoundingClientRect();",
" if(y>=rect.top&&y<=rect.bottom) return parseInt(items[i].dataset.idx);",
" }",
" if(items.length>0){",
" var lastRect=items[items.length-1].getBoundingClientRect();",
" if(y>lastRect.bottom) return parseInt(items[items.length-1].dataset.idx);",
" return parseInt(items[0].dataset.idx);",
" }",
" return -1;",
" }",
" listEl.querySelectorAll('.ep-item').forEach(function(item,idx){",
" // Mouse drag",
" item.addEventListener('dragstart',function(e){ dragIdx=idx; item.classList.add('drag
" item.addEventListener('dragend',function(){ item.classList.remove('dragging'); });",
" item.addEventListener('dragover',function(e){ e.preventDefault(); listEl.querySelect
" item.addEventListener('dragleave',function(){ item.classList.remove('drag-over'); })
" item.addEventListener('drop',function(e){",
" e.preventDefault(); item.classList.remove('drag-over');",
" var dropIdx=parseInt(item.dataset.idx);",
" if(dragIdx===null||dragIdx===dropIdx) return;",
" var list=getList(listId); if(!list) return;",
" var moved=list.episodes.splice(dragIdx,1)[0];",
" list.episodes.splice(dropIdx,0,moved);",
" dragIdx=null; renderListEpisodes(listId); updateEpCount(listId);",
" });",
" // Touch drag (handle grip icon to avoid scroll conflict)",
" var grip=item.querySelector('.ep-drag');",
" var touchSource=grip||item;",
" touchSource.addEventListener('touchstart',function(e){",
" dragIdx=idx; item.classList.add('dragging');",
" },{passive:true});",
" touchSource.addEventListener('touchmove',function(e){",
" if(dragIdx===null) return;",
" e.preventDefault();",
" var y=e.touches[0].clientY;",
" listEl.querySelectorAll('.ep-item').forEach(function(i){ i.classList.remove('drag-
" var overIdx=getItemAtY(y);",
" if(overIdx>=0){ var overItem=listEl.querySelectorAll('.ep-item')[overIdx]; if(over
" },{passive:false});",
" touchSource.addEventListener('touchend',function(e){",
" if(dragIdx===null) return;",
" item.classList.remove('dragging');",
" listEl.querySelectorAll('.ep-item').forEach(function(i){ i.classList.remove('drag-
" var y=e.changedTouches[0].clientY;",
" var dropIdx=getItemAtY(y);",
" if(dropIdx>=0&&dropIdx!==dragIdx){",
" var list=getList(listId); if(!list) return;",
" var moved=list.episodes.splice(dragIdx,1)[0];",
" list.episodes.splice(dropIdx,0,moved);",
" renderListEpisodes(listId); updateEpCount(listId);",
" }",
" dragIdx=null;",
" },{passive:true});",
" });",
"}",
"",
// ── Modal ──
"async function openModal(listId) {",
" var list=getList(listId); if(!list) return;",
" modalData.listId=listId; modalData.tmdbId=list.tmdbId; modalData.allEpisodes=[]; modal
" modalData.selected=new Set(list.episodes.map(function(e){ return e.season+':'+e.episod
" document.getElementById('modal-show-name').textContent=list.tmdbName;",
" document.getElementById('modal-show-sub').textContent='Loading...';",
" document.getElementById('modal-poster').src=list.tmdbPoster||'';",
" document.getElementById('modal-season-filters').innerHTML='';",
" document.getElementById('modal-ep-list').innerHTML='<div class=\"loading-state\"><div
" updateModalCount();",
" document.getElementById('modal-backdrop').classList.add('open');",
" document.body.style.overflow='hidden';",
" try {",
" var r=await fetch('/api/episodes?tmdbId='+list.tmdbId+'&apiKey='+encodeURIComponent(
" var d=await r.json();",
" if(d.error) throw new Error(d.error);",
" modalData.allEpisodes=d.episodes;",
" document.getElementById('modal-show-sub').textContent=d.show.seasons+' season'+(d.sh
" var seasons=[]; d.episodes.forEach(function(e){ if(seasons.indexOf(e.season)===-1) s
" var filters=document.getElementById('modal-season-filters');",
" var btns=['<button class=\"season-btn active\" onclick=\"setSeasonFilter(\\'all\\',t
" seasons.forEach(function(s){ btns.push('<button class=\"season-btn\" onclick=\"setSe
" filters.innerHTML=btns.join(''); renderModalEpisodes();",
" } catch(e){ document.getElementById('modal-ep-list').innerHTML='<p style=\"padding:1re
"}",
"function setSeasonFilter(val,btn){ modalData.filteredSeason=val; document.querySelectorA
"function renderModalEpisodes() {",
" var eps=modalData.filteredSeason==='all'?modalData.allEpisodes:modalData.allEpisodes.f
" var list=document.getElementById('modal-ep-list');",
" if(!eps.length){ list.innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">No e
" list.innerHTML=eps.map(function(ep){",
" var key=ep.season+':'+ep.episode; var sel=modalData.selected.has(key);",
" var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'0');
" var th=ep.still?'<img class=\"modal-ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading
" return '<div class=\"modal-ep-item'+(sel?' selected':'')+' \" onclick=\"toggleEp(\\'
" }).join('');",
"}",
"function toggleEp(key,el){ if(modalData.selected.has(key)){ modalData.selected.delete(ke
"function updateModalCount(){ document.getElementById('modal-sel-count').textContent=moda
"function addSelectedEpisodes() {",
" var list=getList(modalData.listId); if(!list){ closeModal(); return; }",
" var keys=Array.from(modalData.selected);",
" var episodes=keys.map(function(k){ var p=k.split(':').map(Number); return modalData.al
" var existingKeys=new Set(list.episodes.map(function(e){ return e.season+':'+e.episode;
" var kept=list.episodes.filter(function(e){ return keys.indexOf(e.season+':'+e.episode)
" var newEps=episodes.filter(function(e){ return !existingKeys.has(e.season+':'+e.episod
" list.episodes=kept.concat(newEps);",
" closeModal(); renderListEpisodes(modalData.listId); updateEpCount(modalData.listId);",
"}",
"function closeModal(){ document.getElementById('modal-backdrop').classList.remove('open'
"function closeModalOnBackdrop(e){ if(e.target===document.getElementById('modal-backdrop'
"",
// ── IMDB episode import (FIXED) ──
"async function importImdbList(listId) {",
" var list=getList(listId); if(!list) return;",
" var input=document.getElementById('imdb-url-'+listId);",
" var btn=document.getElementById('imdb-btn-'+listId);",
" var status=document.getElementById('imdb-status-'+listId);",
" var url=(input?input.value:'').trim();",
" if(!url){ if(status){ status.textContent='Please enter an IMDB list URL'; status.class
" if(btn){ btn.disabled=true; btn.innerHTML='<span class=\"spinner\"></span>'; }",
" if(status){ status.textContent='Fetching\u2026'; status.className='import-status'; }",
" try {",
" var r=await fetch('/api/imdb-list?url='+encodeURIComponent(url)+'&apiKey='+encodeURI
" var d=await r.json();",
" if(d.error) throw new Error(d.error);",
" if(!d.episodes||!d.episodes.length) throw new Error('No matching episodes found for
" var existingKeys=new Set(list.episodes.map(function(e){ return e.season+':'+e.episod
" var allEpsForShow=modalData.tmdbId===list.tmdbId?modalData.allEpisodes:[];",
" var added=0;",
" for(var i=0;i<d.episodes.length;i++){",
" var ref=d.episodes[i]; var key=ref.season+':'+ref.episode;",
" if(!existingKeys.has(key)){ existingKeys.add(key); var full=allEpsForShow.find(fun
" }",
" var msg='Added '+added+' episode'+(added!==1?'s':'');",
" if(d.skipped) msg+=' ('+d.skipped+' not found)';",
" if(status){ status.textContent=msg; status.className='import-status ok'; }",
" if(input) input.value='';",
" renderListEpisodes(listId); updateEpCount(listId);",
" } catch(e){ if(status){ status.textContent='Error: '+e.message; status.className='impo
" finally{ if(btn){ btn.disabled=false; btn.textContent='Import'; } }",
"}",
"",
// ── Season Zero ──
"function toggleSzeroExpand() {",
" var card=document.getElementById('szero-card');",
" card.classList.toggle('expanded');",
" var btn=document.getElementById('szero-expand-btn');",
" btn.textContent=card.classList.contains('expanded')?'Collapse \u25b2':'Configure \u25b
"}",
"",
// ── Search for shows ──
"var searchTimer;",
"function debounceSearch(q) {",
" clearTimeout(searchTimer);",
Search
loadin
" if(!q.trim()){ document.getElementById('search-results').classList.remove('visible');
" searchTimer=setTimeout(function(){ doSearch(q); },350);",
"}",
"async function doSearch(q) {",
" var box=document.getElementById('search-results');",
" box.classList.add('visible');",
" box.innerHTML='<div class=\"loading-state\"><div class=\"spinner-light\"></div> " try {",
" var r=await fetch('/api/search?q='+encodeURIComponent(q)+'&apiKey='+encodeURICompone
" var d=await r.json();",
" if(!d.results||!d.results.length){ box.innerHTML='<p style=\"padding:1rem;font-size:
" box.innerHTML=d.results.map(function(s){",
" var ph=s.poster?'<img class=\"search-poster\" src=\"'+s.poster+'\" alt=\"\" " return '<div class=\"search-result-item\" onclick=\"addShowToList('+s.id+',\\''+es
" }).join('');",
" } catch(e){ box.innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">Error sear
"}",
"function addShowToList(tmdbId,name,poster) {",
" var listId=uid();",
" state.customSeasons.push({listId:listId,tmdbId:String(tmdbId),tmdbName:name,tmdbPoster
" document.getElementById('search-results').classList.remove('visible');",
" document.getElementById('series-search').value='';",
" renderCustomSeasonsList();",
" setTimeout(function(){ var card=document.getElementById('show-'+listId); if(card) card
"}",
"",
// ── Install page ──
"function buildInstallPage() {",
" var flat=state.customSeasons.map(function(list){",
" return {listId:list.listId,tmdbId:list.tmdbId,label:list.label||'Best Of',prefix:lis
" });",
" state.topN=parseInt(document.getElementById('topN').value)||20;",
" state.showAutoSeason=document.getElementById('showAutoSeason').checked;",
" var cfg={tmdbApiKey:state.apiKey,topN:state.topN,showAutoSeason:state.showAutoSeason,c
" var encoded=btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));",
" var manifestUrl=window.location.origin+'/'+encoded+'/manifest.json';",
" document.getElementById('manifest-url').value=manifestUrl;",
" var listCount=state.customSeasons.length;",
" var showCount=new Set(state.customSeasons.map(function(l){ return l.tmdbId; })).size;"
" var enabledDefaultCount=DEFAULT_CATALOGS.filter(function(d){ var ov=state.catalogEnabl
" var customCatCount=state.customCatalogs.length;",
" document.getElementById('install-summary').innerHTML=",
" '<div class=\"summary-row\"><span class=\"summary-label\">Default catalogs</span><sp
" '<div class=\"summary-row\"><span class=\"summary-label\">Custom catalogs</span><spa
" '<div class=\"summary-row\"><span class=\"summary-label\">Season Zero</span><span cl
" '<div class=\"summary-row\" style=\"margin-bottom:1.4rem\"><span class=\"summary-lab
" var allThumbs=[];",
allThu
" state.customSeasons.forEach(function(list){ list.episodes.forEach(function(ep){ " if(allThumbs.length){",
" var thumbsHtml=allThumbs.concat(allThumbs).map(function(src){ return src?'<img class
" document.getElementById('ep-parade').innerHTML='<div class=\"ep-parade-track\">'+thu
" document.getElementById('ep-parade').style.display='flex';",
" } else { document.getElementById('ep-parade').style.display='none'; }",
"}",
"function openStremio(){ var url=document.getElementById('manifest-url').value; if(!url)
"function copyUrl(){",
" var input=document.getElementById('manifest-url'); input.select();",
" try{document.execCommand('copy');}catch(e){navigator.clipboard&&navigator.clipboard.wr
" var btn=document.getElementById('copy-btn'); btn.textContent='Copied!'; btn.classList.
" setTimeout(function(){ btn.textContent='Copy'; btn.classList.remove('copied'); },2000)
"}",
"",
// ── Hero background ──
"async function loadHeroBg() {",
" try {",
" var r=await fetch('/api/featured');",
" var d=await r.json();",
" if(!d.posters||!d.posters.length) return;",
" var posters=d.posters;",
" var doubled=posters.concat(posters);",
" var track=document.getElementById('hero-bg-track');",
" if(!track) return;",
" track.innerHTML=doubled.map(function(src){ return '<img class=\"hero-bg-img\" " } catch(e){}",
"}",
"window.addEventListener('DOMContentLoaded', loadHeroBg);",
"",
"function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace
"function esc4attr(s){ return String(s||'').replace(/'/g,'&#39;'); }",
].join('\n');
src=\"
// ── Catalog section helper ──
function catalogImportSection(type) {
const typeLabel = type === 'movie' ? 'Movie' : 'Series';
const typeIcon = type === 'movie' ? ' ' : ' ';
return `
<div style="margin-top:18px">
<div style="font-size:0.82rem;font-weight:600;color:var(--text);margin-bottom:10px">${typeI
<!-- TMDB Discover -->
<div style="margin-bottom:10px">
<div class="section-header" style="margin-bottom:6px"><span style="font-size:0.72rem;colo
<button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm('${type}')">+ Add
</div>
<div class="custom-catalog-form" id="custom-catalog-form-${type}">
<div class="form-row">
<div class="field" style="margin-bottom:0"><label>Catalog Name</label><input type="te
<div class="field" style="margin-bottom:0"><label>Genre</label><select id="cc-genre-$
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
<button class="btn btn-primary btn-sm" onclick="addCustomCatalog('${type}')">Add</but
<button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm('${type}')">Can
</div>
</div>
</div>
<!-- MDBList -->
<div style="margin-bottom:10px">
<div style="font-size:0.72rem;color:var(--text-mute);text-transform:uppercase;letter-spac
<div style="display:flex;gap:8px;margin-bottom:6px">
<input type="text" id="mdb-cat-url-${type}" placeholder="https://mdblist.com/lists/user
<button class="btn btn-ghost btn-sm" id="mdb-cat-btn-${type}" onclick="previewMdbCatalo
</div>
<div id="mdb-cat-status-${type}" style="font-size:0.72rem;color:var(--text-mute);min-heig
<div id="mdb-cat-preview-${type}" style="display:none">
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px"
<div class="field" style="margin-bottom:0;flex:1;min-width:140px"><label>Name</label>
<button class="btn btn-primary btn-sm" onclick="addMdbCatalog('${type}')">Add</button
</div>
<div id="mdb-cat-thumbs-${type}" style="display:flex;gap:5px;overflow:hidden;opacity:0.
</div>
</div>
<!-- IMDB List -->
<div style="margin-bottom:10px">
<div style="font-size:0.72rem;color:var(--text-mute);text-transform:uppercase;letter-spac
<div style="display:flex;gap:8px;margin-bottom:6px">
<input type="text" id="imdb-cat-url-${type}" placeholder="https://www.imdb.com/list/ls.
<button class="btn btn-ghost btn-sm" id="imdb-cat-btn-${type}" onclick="previewImdbCata
</div>
<div id="imdb-cat-status-${type}" style="font-size:0.72rem;color:var(--text-mute);min-hei
<div id="imdb-cat-preview-${type}" style="display:none">
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px"
<div class="field" style="margin-bottom:0;flex:1;min-width:140px"><label>Name</label>
<button class="btn btn-primary btn-sm" onclick="addImdbCatalog('${type}')">Add</butto
</div>
</div>
</div>
<div id="imdb-cat-thumbs-${type}" style="display:flex;gap:5px;overflow:hidden;opacity:0
<!-- Handpicked -->
<div style="margin-bottom:4px">
<div style="font-size:0.72rem;color:var(--text-mute);text-transform:uppercase;letter-spac
<div class="field" style="margin-bottom:8px"><input type="text" id="handpicked-name-${typ
<div style="position:relative">
<span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(-
<input type="text" id="handpicked-search-${type}" placeholder="Search for ${typeLabel.t
</div>
<div class="handpicked-search-results" id="handpicked-results-${type}"></div>
<div class="handpicked-added" id="handpicked-tags-${type}"></div>
<button class="btn btn-primary btn-sm mt-1" onclick="addHandpickedCatalog('${type}')">Cre
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
<div class="step-pill active" id="step-1"><span class="step-dot"></span><span class="step
<span class="step-divider">&rsaquo;</span>
<div class="step-pill" id="step-2"><span class="step-dot"></span><span class="step-label"
<span class="step-divider">&rsaquo;</span>
<div class="step-pill" id="step-3"><span class="step-dot"></span><span class="step-label"
<span class="step-divider">&rsaquo;</span>
<div class="step-pill" id="step-4"><span class="step-dot"></span><span class="step-label"
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
<div class="hero-feat"><strong>Full Metadata &amp; Search</strong>Rich posters, rat
<div class="hero-feat"><strong>Curated Episode Lists</strong>Handpick episodes from
<div class="hero-feat"><strong>Catalog Manager</strong>Create, filter, and manage c
<div class="hero-feat"><strong>Season Zero <span class="feat-badge">Beta</span></st
</div>
</div>
</div>
<div class="card">
<div class="card-eyebrow">Step 1</div>
<div class="card-title">Connect to TMDB</div>
<div class="card-sub">Enter your free TMDB API key to get started. GoodTaste uses TMDB
<div class="field">
<label>TMDB API Key</label>
<input type="password" id="apiKey" placeholder="Paste your key here..." autocomplete=
<p class="hint">Free key at <a href="https://www.themoviedb.org/settings/api" target=
</div>
<button class="btn btn-primary btn-lg" style="width:100%" onclick="validateApiKey()" id
</div>
</div>
Each l
<!-- PAGE 2: Curated Lists -->
<div class="page" id="page-2">
<div class="card">
<div class="card-eyebrow">Step 2</div>
<div class="card-title">Curated Episode Lists</div>
<div class="card-sub">Search for a TV show and build a curated list of episodes. <div class="field search-wrap">
<span class="search-icon">&#128269;</span>
<input type="text" id="series-search" placeholder="Search for a TV show..." oninput="
</div>
<div id="search-results" class="search-results"></div>
</div>
<div class="card">
<div class="section-header">
<span class="section-label">Your Lists</span>
</div>
<div id="custom-seasons-list"><div class="empty-state">No shows yet. Search above to ge
</div>
<!-- Season Zero (compact) -->
<div class="szero-card" id="szero-card">
<div class="szero-header" onclick="toggleSzeroExpand()">
<div class="szero-header-left">
<div>
<div class="szero-title-row"><span class="szero-title">Season Zero</span><span cl
<div class="szero-short-desc">Adds the top-rated episodes of every series as a Se
</div>
</div>
<span class="szero-expand" id="szero-expand-btn">Configure &#9660;</span>
</div>
<div class="szero-body">
<p class="szero-full-desc">Automatically adds a "Season Zero" inside every show you o
<div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
<div class="field" style="margin-bottom:0;flex:1;min-width:140px">
<label>Top N Episodes</label>
<input type="number" id="topN" placeholder="20" min="5" max="100" value="20"/>
</div>
<div class="catalog-row" style="flex:1;min-width:180px;margin-bottom:0">
<div class="catalog-row-info"><div style="font-size:0.87rem;font-weight:600;color
<label class="toggle"><input type="checkbox" id="showAutoSeason"/><span class="to
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
<div class="card-sub">Toggle default catalogs, rename them, or build custom ones from T
<!-- Movies section -->
<div id="cat-section-hdr-movie" class="catalog-section-header" onclick="toggleCatalogSe
<span class="catalog-section-label">Default Movie Catalogs</span>
<span class="catalog-chevron">&#9660;</span>
</div>
<div id="cat-section-body-movie" class="catalog-collapse-body">
<div id="catalog-defaults-movie"></div>
</div>
<!-- Series section -->
<div id="cat-section-hdr-series" class="catalog-section-header" style="margin-top:8px"
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
</div>
</div>
<div style="font-size:0.9rem;font-weight:600;color:#fff">Custom Catalogs</div>
<div style="font-size:0.78rem;color:var(--text-mute);margin-top:2px">Build catalogs
<div id="custom-catalogs-list" style="margin-bottom:16px"><div class="empty-state" styl
${catalogImportSection('movie')}
<div style="border-top:1px solid var(--border);margin:20px 0"></div>
${catalogImportSection('series')}
</div>
<div class="nav-row">
<button class="btn btn-ghost" onclick="goTo(2)">&larr; Back</button>
<button class="btn btn-primary btn-lg" onclick="goTo(4)">Generate Install Link &rarr;</
</div>
</div>
<!-- PAGE 4: Install -->
<div class="page" id="page-4">
<div class="card">
<div class="install-hero">
<div class="install-hero-title">You have <span>good taste</span></div>
<div class="install-hero-sub">Add GoodTaste directly to Stremio or copy the manifest
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
<button class="btn btn-primary btn-sm" onclick="addSelectedEpisodes()">Save Selection
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