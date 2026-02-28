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
extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }],
})),
{ id: 'tmdb.search_movies', type: 'movie', name: 'Search Movies', extra: [{ name: 'sea
{ id: 'tmdb.search_series', type: 'series', name: 'Search Series', extra: [{ name: 'sea
];
if (customSeasons.length > 0) {
allCatalogs.push({ id: 'tmdb.bestof', type: 'series', name: '\u2728 Curated Lists', extra
}
return {
id: 'community.goodtaste-tmdb',
version: '5.0.0',
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
if (!seriesCache[list.tmdbId]) {
seriesCache[list.tmdbId] = await getSeries(list.tmdbId, apiKey);
}
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
// Search catalogs only respond to search extra
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
const skip const page = parseInt(extrasMap.skip) || 0;
= Math.floor(skip / 20) + 1;
const genre = extrasMap.genre || null;
try {
const defaultDef = DEFAULT_CATALOGS.find(d => d.id === id);
const customDef = (cfg.customCatalogs || []).find(c => c.id === id);
const catDef = defaultDef || customDef;
if (!catDef) return res.json({ metas: [] });
? resp
// Handle MDBList-sourced catalogs
if (catDef.path === '_mdblist_' && catDef.mdblistUrl) {
const listUrl = String(catDef.mdblistUrl).trim();
let fetchUrl = listUrl.endsWith('.json') ? listUrl : listUrl.replace(/\/$/, '') + '.jso
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
}
} catch (e) { /* skip */ }
}
return res.json({ metas });
}
// Handle IMDB list-sourced catalogs
if (catDef.path === '_imdblist_' && catDef.imdbListId) {
const listId = catDef.imdbListId;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
let ttIds = [];
try {
const csvUrl = 'https://www.imdb.com/list/' + listId + '/export';
const resp = await axios.get(csvUrl, {
headers: { 'Accept': 'text/csv,text/plain,*/*', 'User-Agent': UA },
timeout: 20000, validateStatus: (s) => s >= 200 && s < 400,
});
const ct = String(resp.headers && resp.headers['content-type'] || '').toLowerCase();
if (!ct.includes('text/html')) {
const rows = String(resp.data).split('\n');
const header = rows[0] ? rows[0].split(',').map(h => h.replace(/"/g,'').trim().toLo
const constIdx = header.findIndex(h => h === 'const');
const typeIdx = header.findIndex(h => h === 'title type');
if (constIdx !== -1) {
for (let i = 1; i < rows.length; i++) {
const cols = rows[i].split(',');
const ttId = String(cols[constIdx] || '').replace(/"/g,'').trim();
const ttype = typeIdx !== -1 ? String(cols[typeIdx] || '').replace(/"/g,'').tri
if (ttId && ttId.startsWith('tt')) {
if (!ttype || ttype === 'movie' || ttype === 'tvepisode' || ttype === 'tvseri
ttIds.push(ttId);
}
}
}
}
}
} catch(e) { /* fallback */ }
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
// ─── TMDB CATALOG SEARCH API ──────────────────────────────────────────────────
app.get('/api/tmdb-search', async function(req, res) {
const { q, apiKey, type = 'movie' } = req.query;
if (!q || !apiKey) return res.json({ results: [] });
try {
const tmdbType = type === 'series' ? 'tv' : 'movie';
const data = await tmdb('/search/' + tmdbType, apiKey, { query: q });
const results = (data.results || []).slice(0, 8).map(s => ({
id: s.id,
name: tmdbType === 'movie' ? (s.title || s.original_title) : (s.name || s.original_name
poster: s.poster_path ? TMDB_IMG_SM + s.poster_path : null,
year: ((tmdbType === 'movie' ? s.release_date : s.first_air_date) || '').substring(0, 4
vote_average: s.vote_average ? s.vote_average.toFixed(1) : '?',
overview: (s.overview || '').substring(0, 100),
}));
res.json({ results });
} catch (e) { res.status(500).json({ error: e.message }); }
});
// Homepage hero: trending movies + shows for background
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
.map(m => ({ type: 'movie', name: m.title || m.original_title, backdrop: TMDB_IMG_LG +
const showBackdrops = (shows.results || []).slice(0, 10)
.filter(s => s.backdrop_path)
.map(s => ({ type: 'series', name: s.name || s.original_name, backdrop: TMDB_IMG_LG + s
res.json({ backdrops: [...movieBackdrops, ...showBackdrops] });
} catch (e) { res.status(500).json({ error: e.message, backdrops: [] }); }
});
// ─── IMDB LIST IMPORT ─────────────────────────────────────────────────────────
app.get('/api/imdb-list', async function(req, res) {
let { url: listUrl, apiKey, tmdbId } = req.query;
if (!listUrl || !apiKey || !tmdbId) return res.status(400).json({ error: 'url, apiKey, and
tmdbId = String(tmdbId).replace(/^tmdb:/, '').trim();
const listIdMatch = String(listUrl).match(/ls\d+/);
if (!listIdMatch) return res.status(400).json({ error: 'Could not parse IMDB list ID const listId = listIdMatch[0];
from U
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko
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
const urlMatches = [...html.matchAll(/"url"\s*:\s*"https?:\/\/www\.imdb\.com\/title\/(tt\
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
if (constIdx === -1) return res.status(400).json({ error: 'Unexpected CSV format — miss
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
return res.json({ episodes: [], errors: [{ reason: 'No IMDb title IDs found in list' }]
}
const results = [];
const errors = [];
for (const ttId of ttIds) {
try {
const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' const epResults = found.tv_episode_results || [];
if (epResults.length > 0) {
const matches = epResults.filter(ep => String(ep.show_id) === String(tmdbId));
if (matches.length > 0) {
for (const ep of matches) {
results.push({ season: ep.season_number, episode: ep.episode_number });
}
} else {
});
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
if (!listIdMatch) return res.status(400).json({ error: 'Could not parse IMDB list ID const listId = listIdMatch[0];
from U
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko
try {
// Try CSV export first
let ttIds = [];
let listName = '';
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
const header = rows[0] ? rows[0].split(',').map(h => h.replace(/"/g,'').trim().toLowe
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
ttIds = [...new Set(ttIds)].filter(Boolean).slice(0, 50);
if (!ttIds.length) return res.json({ metas: [], count: 0, name: listName });
const metas = [];
for (const ttId of ttIds) {
try {
const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' const mv = (found.movie_results || [])[0];
const tv = (found.tv_results || [])[0];
if (mv) { const m = movieToMeta(mv); if (m.poster) metas.push(m); }
else if (tv) { const m = seriesToMeta(tv); if (m.poster) metas.push(m); }
} catch(e) { /* skip */ }
});
}
res.json({ metas, count: ttIds.length, name: listName, listId });
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
try {
let fetchUrl = urlStr;
if (!fetchUrl.endsWith('.json')) {
fetchUrl = fetchUrl.replace(/\/$/, '') + '.json';
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
} catch (e) { /* skip unresolvable */ }
}
res.json({ metas, count: raw.length, name: listName });
} catch (e) {
console.error('[mdblist-catalog]', e.message);
// Return a more user-friendly error
if (e.response && e.response.status === 404) {
return res.status(404).json({ error: 'MDBList URL not found (404). Check the URL is cor
}
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
releaseInfo: movie.release_date ? movie.release_date.substring(0, 4) : '',
runtime: movie.runtime ? movie.runtime + ' min' : null,
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
const endYear = series.last_air_date ? series.last_air_date.substring(0, 4) : '';
const releaseInfo = series.status === 'Ended' && endYear ? startYear + '-' + endYear : st
res.json({ meta: {
id, type: 'series', name: series.name,
poster: series.poster_path ? TMDB_IMG_MD + series.poster_path : null,
background: series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
description: series.overview, releaseInfo, videos,
runtime: series.episode_run_time && series.episode_run_time[0] ? series.episode_r
genres: (series.genres || []).map(g => g.name),
imdbRating: series.vote_average ? series.vote_average.toFixed(1) : null,
cast, certification: cert || null,
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
id: realId,
title: target.name, season: target.season, episode: target.episode,
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
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,
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
/* ── Topbar ── */
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
.step-pill.done { color: var(--text-dim); }
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
/* ── Main layout ── */
.main { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
@media (max-width: 600px) { .main { padding: 2rem 1rem 5rem; } }
/* ── Pages & transitions ── */
.page { display: none; animation: fadeUp 0.35s cubic-bezier(0.4,0,0.2,1); }
.page.active { display: block; }
@keyframes fadeUp {
from { opacity: 0; transform: translateY(16px); }
to { opacity: 1; transform: translateY(0); }
}
/* ── Hero background ── */
.hero-bg {
position: absolute;
inset: 0;
overflow: hidden;
pointer-events: none;
z-index: 0;
}
.hero-bg-track {
display: flex;
gap: 0;
height: 100%;
animation: bgScroll 60s linear infinite;
will-change: transform;
}
@keyframes bgScroll {
from { transform: translateX(0); }
to { transform: translateX(-50%); }
}
.hero-bg-item {
position: relative;
flex-shrink: 0;
height: 100%;
width: 320px;
}
.hero-bg-item img {
width: 100%;
height: 100%;
object-fit: cover;
transform: skewX(-8deg) scaleX(1.1);
transform-origin: center center;
opacity: 0;
transition: opacity 1s ease;
}
.hero-bg-item img.loaded { opacity: 1; }
.hero-bg-overlay {
position: absolute;
inset: 0;
background: linear-gradient(
to bottom,
rgba(8,8,8,0.55) 0%,
rgba(8,8,8,0.35) 40%,
rgba(8,8,8,0.75) 80%,
rgba(8,8,8,0.98) 100%
);
z-index: 1;
}
/* ── Hero landing ── */
.hero-wrap {
position: relative;
overflow: hidden;
border-radius: 18px;
min-height: 340px;
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
/* ── Cards ── */
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
/* ── Fields ── */
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
@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{t
.hint { font-size: 0.72rem; color: var(--text-mute); margin-top: 6px; }
.hint a { color: var(--gold); text-decoration: none; }
/* ── Buttons ── */
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
.btn-primary {
background: var(--gold);
color: #000;
}
.btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
.btn-primary:active { transform: translateY(0); }
.btn-ghost {
background: transparent;
border: 1px solid var(--border2);
color: var(--text-dim);
}
.btn-ghost:hover { border-color: var(--text-dim); color: var(--text); }
.btn-danger { background: rgba(192,57,43,0.15); border: 1px solid rgba(192,57,43,0.3); co
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
.btn-install:hover { opacity: 0.9; transform: translateY(-2px); box-shadow: 0 8px 32px rg
.btn-sm { padding: 7px 14px; font-size: 0.78rem; }
.btn-lg { padding: 13px 28px; font-size: 0.95rem; }
/* ── Toggle ── */
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
/* ── Section header ── */
.section-header {
display: flex;
align-items: center;
justify-content: space-between;
margin-bottom: 1rem;
}
.section-label {
font-size: 0.68rem;
font-weight: 600;
letter-spacing: 0.1em;
text-transform: uppercase;
color: var(--text-mute);
}
/* ── Search ── */
.search-wrap { position: relative; }
.search-icon {
position: absolute;
left: 14px;
top: 50%;
transform: translateY(-50%);
color: var(--text-mute);
pointer-events: none;
font-size: 0.85rem;
}
.search-wrap input { padding-left: 42px; }
.search-results { margin-top: 8px; display: none; }
.search-results.visible { display: block; }
.search-result-item {
display: flex;
align-items: center;
gap: 12px;
padding: 10px 12px;
border-radius: 10px;
cursor: pointer;
transition: background var(--transition);
border: 1px solid transparent;
}
.search-result-item:hover { background: var(--surface2); border-color: var(--border); }
.search-poster { width: 34px; height: 50px; border-radius: 5px; object-fit: cover; backgr
.search-name { font-size: 0.87rem; font-weight: 600; color: var(--text); }
.search-meta { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }
/* ── List cards ── */
.show-card {
border: 1px solid var(--border);
border-radius: 14px;
overflow: hidden;
margin-bottom: 10px;
background: var(--surface2);
transition: border-color var(--transition);
}
.show-card:hover { border-color: var(--border2); }
.show-card-header {
display: flex;
align-items: center;
gap: 14px;
padding: 14px 16px;
}
.show-poster { width: 32px; height: 48px; border-radius: 5px; object-fit: cover; backgrou
.show-card-info { flex: 1; min-width: 0; }
.show-card-name {
font-size: 0.88rem;
font-weight: 600;
color: #fff;
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
}
.show-card-sub { font-size: 0.71rem; color: var(--text-mute); margin-top: 2px; }
.show-card-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.ep-count-badge {
font-size: 0.7rem;
color: var(--text-mute);
font-family: 'DM Mono', monospace;
background: var(--surface);
border: 1px solid var(--border);
padding: 3px 8px;
border-radius: 20px;
}
.ep-count-badge.has-eps { color: var(--gold); border-color: var(--gold-border); backgroun
/* ── Episode list inside show ── */
.show-ep-body { display: none; border-top: 1px solid var(--border); }
.show-card.expanded .show-ep-body { display: block; }
.show-ep-inner { padding: 12px 16px 16px; }
/* Rename row */
.show-rename-row {
display: flex;
gap: 8px;
margin-bottom: 12px;
align-items: center;
}
.show-rename-prefix { max-width: 70px; font-size: 1.1rem; text-align: center; padding: 9p
.show-rename-label { flex: 1; }
/* Add tabs */
.add-tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--surf
.add-tab {
flex: 1;
padding: 9px 8px;
font-size: 0.73rem;
font-weight: 600;
text-align: center;
cursor: pointer;
color: var(--text-mute);
background: transparent;
border: none;
font-family: 'DM Sans', sans-serif;
transition: all var(--transition);
border-bottom: 2px solid transparent;
letter-spacing: 0.03em;
}
.add-tab.active { color: var(--gold); border-bottom-color: var(--gold); }
.add-tab:hover:not(.active) { color: var(--text-dim); }
.add-panel { display: none; padding: 14px; background: var(--surface); }
.add-panel.active { display: block; }
/* Paste panel */
.paste-hint { font-size: 0.72rem; color: var(--text-mute); margin-bottom: 8px; line-heigh
.paste-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap
.paste-status { font-size: 0.73rem; }
.paste-status.ok { color: #4caf82; }
.paste-status.err { color: #e05252; }
/* Import row */
.import-row { display: flex; gap: 8px; }
.import-row input { flex: 1; font-size: 0.82rem; }
.import-status { font-size: 0.73rem; margin-top: 6px; color: var(--text-mute); min-height
.import-status.ok { color: #4caf82; }
.import-status.err { color: #e05252; }
/* Episode list */
.ep-list { list-style: none; }
.ep-item {
display: flex;
align-items: center;
gap: 10px;
padding: 8px 10px;
border-radius: 9px;
margin-bottom: 5px;
background: var(--bg);
border: 1px solid var(--border);
touch-action: none;
user-select: none;
transition: border-color var(--transition), opacity var(--transition);
-webkit-user-select: none;
}
.ep-item.dragging { opacity: 0.4; }
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
.ep-list-actions { display: flex; gap: 8px; margin-top: 12px; }
nowrap
/* ── Catalog rows ── */
.catalog-row {
display: flex;
align-items: center;
gap: 12px;
padding: 11px 14px;
border-radius: 10px;
background: var(--surface2);
border: 1px solid var(--border);
margin-bottom: 8px;
}
.catalog-row-info { flex: 1; min-width: 0; }
.catalog-row-name-input {
background: transparent;
border: none;
border-bottom: 1px solid transparent;
border-radius: 0;
padding: 2px 0;
font-size: 0.87rem;
font-weight: 600;
color: var(--text);
width: 100%;
font-family: 'DM Sans', sans-serif;
transition: border-color var(--transition);
}
.catalog-row-name-input:focus {
outline: none;
border-bottom-color: var(--gold);
box-shadow: none;
}
.catalog-row-type { font-size: 0.7rem; color: var(--text-mute); margin-top: 2px; }
.catalog-section-label { font-size: 0.68rem; font-weight: 600; color: var(--text-mute); t
/* Collapsible default catalogs */
.catalog-group-header {
display: flex;
align-items: center;
justify-content: space-between;
cursor: pointer;
padding: 8px 0;
margin-bottom: 4px;
user-select: none;
}
.catalog-group-header:hover .catalog-section-label { color: var(--text-dim); }
.catalog-group-chevron {
font-size: 0.7rem;
color: var(--text-mute);
transition: transform var(--transition);
}
.catalog-group.collapsed .catalog-group-chevron { transform: rotate(-90deg); }
.catalog-group-body { overflow: hidden; transition: all 0.25s ease; }
.catalog-group.collapsed .catalog-group-body { display: none; }
/* Custom catalog form */
.custom-catalog-form { background: var(--surface2); border: 1px solid var(--border2); bor
.custom-catalog-form.open { display: block; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 480px) { .form-row { grid-template-columns: 1fr; } }
.custom-catalog-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
.custom-catalog-item-info { flex: 1; }
.custom-catalog-item-name { font-size: 0.86rem; font-weight: 600; color: var(--text); }
.custom-catalog-item-sub { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; f
/* Add catalog tabs */
.add-cat-tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 14p
.add-cat-tab {
flex: 1; padding: 8px 6px; font-size: 0.72rem; font-weight: 600;
text-align: center; cursor: pointer; color: var(--text-mute); background: transparent;
border: none; font-family: 'DM Sans', sans-serif; transition: all var(--transition);
border-bottom: 2px solid transparent; letter-spacing: 0.03em;
}
.add-cat-tab.active { color: var(--gold); border-bottom-color: var(--gold); }
.add-cat-panel { display: none; }
.add-cat-panel.active { display: block; }
/* ── Season Zero card ── */
.szero-card {
background: rgba(240,192,64,0.03);
border: 1px solid rgba(240,192,64,0.12);
border-radius: 14px;
padding: 14px 18px;
margin-bottom: 1rem;
}
.szero-header {
display: flex;
align-items: center;
gap: 12px;
justify-content: space-between;
cursor: pointer;
}
.szero-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.szero-title-row { display: flex; align-items: center; gap: 8px; }
.szero-title-text { font-size: 0.88rem; font-weight: 600; color: var(--text); }
.beta-badge {
display: inline-flex;
align-items: center;
background: rgba(240,192,64,0.1);
border: 1px solid rgba(240,192,64,0.3);
color: var(--gold);
font-size: 0.55rem;
font-weight: 700;
letter-spacing: 0.1em;
text-transform: uppercase;
padding: 2px 5px;
border-radius: 3px;
}
.szero-desc { font-size: 0.75rem; color: var(--text-mute); margin-top: 2px; line-height:
.szero-body { margin-top: 14px; padding-top: 14px; border-top: 1px solid rgba(240,192,64,
.szero-card.expanded .szero-body { display: block; }
.szero-expand-icon { color: var(--text-mute); font-size: 0.8rem; transition: transform va
.szero-card.expanded .szero-expand-icon { transform: rotate(180deg); }
.szero-warning { font-size: 0.75rem; color: rgba(240,192,64,0.7); background: rgba(240,19
/* ── Modal ── */
.modal-backdrop {
display: none;
position: fixed;
inset: 0;
background: rgba(0,0,0,0.8);
backdrop-filter: blur(4px);
z-index: 500;
align-items: center;
justify-content: center;
padding: 1.5rem;
}
.modal-backdrop.open { display: flex; }
.modal {
background: var(--surface);
border: 1px solid var(--border2);
border-radius: 20px;
max-width: 580px;
width: 100%;
max-height: 88vh;
display: flex;
flex-direction: column;
overflow: hidden;
animation: modalIn 0.25s cubic-bezier(0.4,0,0.2,1);
}
@keyframes modalIn {
from { opacity: 0; transform: scale(0.95) translateY(10px); }
to { opacity: 1; transform: scale(1) translateY(0); }
}
.modal-header { padding: 1.4rem 1.6rem 1rem; border-bottom: 1px solid var(--border); disp
.modal-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; backgro
.modal-title { font-size: 1rem; font-weight: 700; color: #fff; }
.modal-sub { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }
.modal-close { margin-left: auto; color: var(--text-mute); cursor: pointer; font-size: 1
.modal-close:hover { color: var(--text); }
.modal-filter { padding: 12px 1.6rem; border-bottom: 1px solid var(--border); display: fl
.season-btn {
padding: 4px 12px;
border-radius: 20px;
font-size: 0.72rem;
font-weight: 600;
background: var(--surface2);
border: 1px solid var(--border);
color: var(--text-mute);
cursor: pointer;
transition: all var(--transition);
}
.season-btn.active { background: var(--gold); border-color: var(--gold); color: #000; }
.modal-ep-list { flex: 1; overflow-y: auto; padding: 10px 1.6rem; }
.modal-ep-item {
display: flex;
align-items: center;
gap: 10px;
padding: 9px 10px;
border-radius: 10px;
margin-bottom: 4px;
cursor: pointer;
transition: background var(--transition);
border: 1.5px solid transparent;
}
.modal-ep-item:hover { background: var(--surface2); }
.modal-ep-item.selected { border-color: var(--gold); background: var(--gold-dim); }
.modal-ep-thumb { width: 64px; height: 36px; border-radius: 5px; object-fit: cover; backg
.modal-ep-info { flex: 1; min-width: 0; }
.modal-ep-name { font-size: 0.82rem; font-weight: 600; color: var(--text); white-space:
.modal-ep-meta { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; }
.modal-ep-check {
width: 20px; height: 20px;
border-radius: 6px;
border: 1.5px solid var(--border2);
flex-shrink: 0;
display: flex;
align-items: center;
justify-content: center;
font-size: 0.65rem;
transition: all var(--transition);
}
.modal-ep-item.selected .modal-ep-check { background: var(--gold); border-color: var(--go
.modal-footer {
padding: 1rem 1.6rem;
border-top: 1px solid var(--border);
display: flex;
align-items: center;
justify-content: space-between;
gap: 10px;
}
.modal-sel-label { font-size: 0.8rem; color: var(--text-dim); }
/* ── Install / summary ── */
.install-hero { text-align: center; padding: 1rem 0 2rem; }
.install-hero-title {
font-family: 'Playfair Display', serif;
font-size: 2rem;
font-weight: 700;
color: #fff;
margin-bottom: 6px;
letter-spacing: -0.02em;
}
.install-hero-title span { color: var(--gold); font-style: italic; }
.install-hero-sub { font-size: 0.83rem; color: var(--text-dim); }
.summary-row {
display: flex;
align-items: center;
justify-content: space-between;
padding: 11px 14px;
border-radius: 10px;
background: var(--surface2);
border: 1px solid var(--border);
margin-bottom: 8px;
font-size: 0.82rem;
}
.summary-label { color: var(--text-dim); }
.summary-value { color: #fff; font-weight: 600; font-family: 'DM Mono', monospace; .summary-value.accent { color: var(--gold); }
font-s
/* Episode parade on install */
.ep-parade {
display: flex;
gap: 6px;
overflow: hidden;
margin: 1.5rem 0;
mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent);
-webkit-mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transp
}
.ep-parade-track {
display: flex;
gap: 6px;
animation: scroll 20s linear infinite;
flex-shrink: 0;
}
@keyframes scroll {
from { transform: translateX(0); }
to { transform: translateX(-50%); }
}
.parade-thumb {
width: 80px;
height: 45px;
border-radius: 6px;
object-fit: cover;
flex-shrink: 0;
opacity: 0.7;
}
.parade-thumb.no-img {
background: var(--surface2);
border: 1px solid var(--border);
display: flex;
align-items: center;
justify-content: center;
font-size: 1.2rem;
}
.or-divider { text-align: center; font-size: 0.72rem; color: var(--text-mute); margin: 14
.copy-row { display: flex; gap: 8px; }
.copy-row input {
flex: 1;
font-size: 0.72rem;
color: var(--text-mute);
padding: 10px 12px;
font-family: 'DM Mono', monospace;
}
.btn-copy {
flex-shrink: 0;
padding: 10px 18px;
background: var(--surface2);
border: 1px solid var(--border2);
border-radius: var(--radius);
color: var(--text-dim);
font-size: 0.78rem;
font-weight: 600;
cursor: pointer;
transition: all var(--transition);
font-family: 'DM Sans', sans-serif;
}
.btn-copy:hover { border-color: var(--gold); color: var(--gold); }
.btn-copy.copied { border-color: #4caf82; color: #4caf82; }
/* ── Nav row ── */
.nav-row { display: flex; justify-content: space-between; align-items: center; margin-top
/* ── Spinner ── */
.spinner {
display: inline-block;
width: 13px; height: 13px;
border: 2px solid rgba(0,0,0,0.2);
border-top-color: rgba(0,0,0,0.7);
border-radius: 50%;
animation: spin 0.7s linear infinite;
}
.spinner-light {
display: inline-block;
width: 13px; height: 13px;
border: 2px solid rgba(255,255,255,0.2);
border-top-color: rgba(255,255,255,0.8);
border-radius: 50%;
animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.loading-state { display: flex; align-items: center; justify-content: center; gap: 10px;
/* ── Empty state ── */
.empty-state { text-align: center; padding: 2.5rem 1rem; color: var(--text-mute); font-si
/* ── Utilities ── */
.flex-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mt-1 { margin-top: 8px; }
.mt-2 { margin-top: 14px; }
`;
const clientJS = [
"var DEFAULT_CATALOGS = " + defaultCatalogsJson + ";",
"var state = {",
" apiKey: '', topN: 20, showAutoSeason: false,",
" customSeasons: [], catalogEnabled: {}, catalogNames: {}, customCatalogs: []",
"};",
"var modalData = { listId: null, tmdbId: null, allEpisodes: [], filteredSeason: 'all', se
"var genreCache = { movie: null, tv: null };",
"var TOTAL_PAGES = 4;",
"",
"function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
"",
"function goTo(n) {",
" document.querySelectorAll('.page').forEach(function(p,i){ p.classList.toggle('active',
" document.querySelectorAll('[id^=step-]').forEach(function(el) {",
" var num = parseInt(el.id.replace('step-',''));",
" el.classList.remove('active','done');",
" if (num===n) el.classList.add('active');",
" else if (num<n) el.classList.add('done');",
" });",
" if (n===TOTAL_PAGES) buildInstallPage();",
" window.scrollTo({top:0,behavior:'smooth'});",
"}",
"",
// ── Hero background loader ──
"async function loadHeroBackgrounds() {",
" var apiKey = document.getElementById('apiKey').value.trim();",
" if (!apiKey) {",
" // Try to load without key - just show static gradient",
" return;",
" }",
" try {",
" var r = await fetch('/api/hero-backdrops?apiKey=' + encodeURIComponent(apiKey));",
" var d = await r.json();",
" if (!d.backdrops || !d.backdrops.length) return;",
" renderHeroBackgrounds(d.backdrops);",
" } catch(e) { /* silent fail */ }",
"}",
"function renderHeroBackgrounds(backdrops) {",
" var track = document.getElementById('hero-bg-track');",
" if (!track) return;",
" var items = backdrops.concat(backdrops); // duplicate for infinite scroll",
" track.innerHTML = items.map(function(b) {",
" return '<div class=\"hero-bg-item\"><img src=\"' + b.backdrop + '\" alt=\"\" onload=
" }).join('');",
"}",
"",
// ── API key validation ──
"async function validateApiKey() {",
" var input = document.getElementById('apiKey');",
" var key = input.value.trim();",
" var btn = document.getElementById('btn-validate');",
" if (!key) { flashError(input); return; }",
" btn.innerHTML = '<span class=\"spinner\"></span> Checking...';",
" btn.disabled = true;",
" try {",
" var r = await fetch('/api/search?q=test&apiKey='+encodeURIComponent(key));",
" var d = await r.json();",
" if (d.error) throw new Error(d.error);",
" state.apiKey = key;",
" loadHeroBackgrounds();",
" renderDefaultCatalogs();",
" goTo(2);",
" } catch(e) {",
" flashError(input);",
" input.placeholder = 'Invalid key — try again';",
" } finally { btn.innerHTML = 'Continue &rarr;'; btn.disabled = false; }",
"}",
"",
"function flashError(el) { el.classList.add('error'); el.focus(); setTimeout(function(){
"",
// ── Tab switching for add panels ──
"function switchAddTab(listId, tab) {",
" ['picker','imdb','paste'].forEach(function(t) {",
" var btn = document.getElementById('add-tab-'+t+'-'+listId);",
" var panel = document.getElementById('add-panel-'+t+'-'+listId);",
" if (btn) btn.classList.toggle('active', t===tab);",
" if (panel) panel.classList.toggle('active', t===tab);",
" });",
"}",
"",
// ── Parse paste episodes ──
"function parsePasteEpisodes(text) {",
" var results = [];",
" var re = /[Ss](\\d{1,3})[Ee](\\d{1,3})|(?:^|\\D)(\\d{1,2})[Xx](\\d{1,3})(?:\\D|$)/gm;"
" var m;",
" while ((m = re.exec(text)) !== null) {",
" var s = parseInt(m[1]||m[3]); var e = parseInt(m[2]||m[4]);",
" if (!isNaN(s)&&!isNaN(e)&&s>0&&e>0) results.push({season:s,episode:e});",
" }",
" var seen = new Set();",
" return results.filter(function(ep){ var k=ep.season+':'+ep.episode; if(seen.has(k)) re
"}",
"",
"function applyPaste(listId) {",
" var ta = document.getElementById('paste-input-'+listId);",
" var st = document.getElementById('paste-status-'+listId);",
" if (!ta||!st) return;",
" var text = ta.value.trim();",
" if (!text) { st.textContent='Paste some episode codes first'; st.className='paste-stat
" var parsed = parsePasteEpisodes(text);",
" if (!parsed.length) { st.textContent='No codes found. Use S01E01 or 1x01 format.'; st.
" var list = getList(listId); if (!list) return;",
" var allEps = (modalData.tmdbId===list.tmdbId) ? modalData.allEpisodes : [];",
" var existingKeys = new Set(list.episodes.map(function(e){ return e.season+':'+e.episod
" var added=0;",
" for (var i=0;i<parsed.length;i++) {",
" var ref=parsed[i]; var key=ref.season+':'+ref.episode;",
" if (!existingKeys.has(key)) {",
" existingKeys.add(key);",
" var full=allEps.find(function(e){ return e.season===ref.season&&e.episode===ref.ep
" list.episodes.push(full||ref); added++;",
" }",
" }",
" st.textContent='Added '+added+' of '+parsed.length+' episode'+(parsed.length!==1?'s':'
" st.className='paste-status ok';",
" ta.value='';",
" renderListEpisodes(listId);",
" updateEpCount(listId);",
"}",
"",
// ── Catalog UI ──
"function renderDefaultCatalogs() {",
" ['movie','series'].forEach(function(type) {",
" var el = document.getElementById('catalog-defaults-'+type);",
" var cats = DEFAULT_CATALOGS.filter(function(c){ return c.type===type; });",
" el.innerHTML = cats.map(function(c) {",
" var checked = state.catalogEnabled[c.id]!==undefined ? state.catalogEnabled[c.id]
" var displayName = state.catalogNames[c.id] || c.name;",
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
"function setCatalogEnabled(id, val) { state.catalogEnabled[id]=val; }",
"function setCatalogName(id, val) { state.catalogNames[id]=val; }",
"function toggleCatalogGroup(type) {",
" var grp = document.getElementById('catalog-group-'+type);",
" if (grp) grp.classList.toggle('collapsed');",
"}",
"",
// ── Add catalog tab switching ──
"function switchAddCatTab(tab) {",
" ['tmdb','mdblist','imdb'].forEach(function(t) {",
" var btn = document.getElementById('add-cat-tab-'+t);",
" var panel = document.getElementById('add-cat-panel-'+t);",
" if (btn) btn.classList.toggle('active', t===tab);",
" if (panel) panel.classList.toggle('active', t===tab);",
" });",
" if (tab==='tmdb') loadGenresForCustom();",
"}",
"",
"function toggleCustomCatalogForm() {",
" var form = document.getElementById('custom-catalog-form');",
" form.classList.toggle('open');",
" if (form.classList.contains('open')) {",
" switchAddCatTab('tmdb');",
" loadGenresForCustom();",
" }",
"}",
"async function loadGenresForCustom() {",
" var type = document.getElementById('cc-type').value;",
" var tt = type==='series'?'tv':'movie';",
" if (genreCache[tt]) { populateGenreSelect(genreCache[tt]); return; }",
" try {",
" var r = await fetch('/api/genres?apiKey='+encodeURIComponent(state.apiKey)+'&type='+
" var d = await r.json();",
" genreCache[tt]=d.genres||[]; populateGenreSelect(genreCache[tt]);",
" } catch(e) {}",
"}",
"function populateGenreSelect(genres) {",
" var sel=document.getElementById('cc-genre');",
" if (!sel) return;",
" sel.innerHTML='<option value=\"\">Any Genre</option>'+genres.map(function(g){ return '
"}",
"function addCustomCatalog() {",
" var name=document.getElementById('cc-name').value.trim();",
" var type=document.getElementById('cc-type').value;",
" var genre=document.getElementById('cc-genre').value;",
" var sort=document.getElementById('cc-sort').value;",
" if (!name) { var n=document.getElementById('cc-name'); n.classList.add('error'); setTi
" var tt=type==='series'?'tv':'movie';",
" var params={sort_by:sort};",
" if (genre) params.with_genres=genre;",
" state.customCatalogs.push({id:'custom.'+Date.now(), name:name, type:type, path:'/disco
" document.getElementById('cc-name').value=''; document.getElementById('cc-genre').value
" document.getElementById('custom-catalog-form').classList.remove('open');",
" renderCustomCatalogsList();",
"}",
"function removeCustomCatalog(id) { state.customCatalogs=state.customCatalogs.filter(func
"function renderCustomCatalogsList() {",
" var el=document.getElementById('custom-catalogs-list');",
" if (!state.customCatalogs.length) { el.innerHTML='<div class=\"empty-state\">No custom
" var sortLabels={'popularity.desc':'Popular','vote_average.desc':'Top Rated','release_d
" el.innerHTML=state.customCatalogs.map(function(c){",
" var sl='';",
" var sub='';",
" if (c.path==='_mdblist_') sub='MDBList \u00b7 '+c.type;",
" else if (c.path==='_imdblist_') sub='IMDB List \u00b7 '+c.type;",
" else { sl=(c.params&&sortLabels[c.params.sort_by])||''; var gp=c.params&&c.params.wi
" return '<div class=\"custom-catalog-item\"><div class=\"custom-catalog-item-info\"><
" }).join('');",
"}",
"",
// ── MDBList catalog ──
"var mdbCatalogPreviewData = null;",
"async function previewMdbCatalog() {",
" var input = document.getElementById('mdb-cat-url');",
" var status = document.getElementById('mdb-cat-status');",
this l
" var btn = document.getElementById('mdb-cat-btn');",
" var preview = document.getElementById('mdb-cat-preview');",
" var url = (input ? input.value : '').trim();",
" if (!url) { status.textContent = 'Please enter an MDBList URL'; status.style.color = '
" btn.disabled = true; btn.innerHTML = '<span class=\"spinner-light\"></span>';",
" status.textContent = 'Fetching list\u2026'; status.style.color = 'var(--text-mute)';",
" preview.style.display = 'none'; mdbCatalogPreviewData = null;",
" try {",
" var r = await fetch('/api/mdblist-catalog?url=' + encodeURIComponent(url) + '&apiKey
" var d = await r.json();",
" if (d.error) throw new Error(d.error);",
" if (!d.metas || !d.metas.length) throw new Error('No movies or shows found in " mdbCatalogPreviewData = { url: url, metas: d.metas, name: d.name, count: d.count };"
" if (d.name) document.getElementById('mdb-cat-name').value = d.name;",
" var movieCount = d.metas.filter(function(m){ return m.type === 'movie'; }).length;",
" document.getElementById('mdb-cat-type').value = movieCount >= d.metas.length / 2 ? '
" var thumbs = d.metas.slice(0, 8).map(function(m) {",
" if (!m.poster) return '';",
" return '<img src=\"'+m.poster+'\" style=\"width:36px;height:54px;border-radius:5px
" }).join('');",
" document.getElementById('mdb-cat-thumbs').innerHTML = thumbs;",
" var nameStr = d.name ? ' \u2014 ' + d.name : '';",
" status.textContent = d.count + ' item' + (d.count !== 1 ? 's' : '') + ' found' + nam
" status.style.color = 'var(--gold)';",
" preview.style.display = 'block';",
" } catch(e) {",
" status.textContent = 'Error: ' + e.message; status.style.color = '#e05252';",
" } finally { btn.disabled = false; btn.textContent = 'Preview'; }",
"}",
"function addMdbCatalog() {",
" if (!mdbCatalogPreviewData) return;",
" var name = document.getElementById('mdb-cat-name').value.trim() || 'MDBList';",
" var type = document.getElementById('mdb-cat-type').value;",
" var url = mdbCatalogPreviewData.url;",
" state.customCatalogs.push({ id: 'mdblist.' + Date.now(), name: name, type: type, path:
" document.getElementById('mdb-cat-url').value = '';",
" document.getElementById('mdb-cat-preview').style.display = 'none';",
" document.getElementById('mdb-cat-status').textContent = '\u2713 Added \"' + name + '\"
" document.getElementById('mdb-cat-status').style.color = 'var(--gold)';",
" mdbCatalogPreviewData = null;",
" renderCustomCatalogsList();",
"}",
"",
// ── IMDB catalog ──
"var imdbCatalogPreviewData = null;",
"async function previewImdbCatalog() {",
list.'
" var input = document.getElementById('imdb-cat-url');",
" var status = document.getElementById('imdb-cat-status');",
" var btn = document.getElementById('imdb-cat-btn');",
" var preview = document.getElementById('imdb-cat-preview');",
" var url = (input ? input.value : '').trim();",
" if (!url) { status.textContent = 'Please enter an IMDB list URL'; status.style.color =
" btn.disabled = true; btn.innerHTML = '<span class=\"spinner-light\"></span>';",
" status.textContent = 'Fetching IMDB list\u2026'; status.style.color = 'var(--text-mute
" preview.style.display = 'none'; imdbCatalogPreviewData = null;",
" try {",
" var r = await fetch('/api/imdb-catalog?url=' + encodeURIComponent(url) + '&apiKey='
" var d = await r.json();",
" if (d.error) throw new Error(d.error);",
" if (!d.metas || !d.metas.length) throw new Error('No items found in this IMDB " imdbCatalogPreviewData = { listId: d.listId, url: url, metas: d.metas, name: d.name,
" if (d.name) document.getElementById('imdb-cat-name').value = d.name;",
" var movieCount = d.metas.filter(function(m){ return m.type === 'movie'; }).length;",
" document.getElementById('imdb-cat-type').value = movieCount >= d.metas.length / 2 ?
" var thumbs = d.metas.slice(0, 8).map(function(m) {",
" if (!m.poster) return '';",
" return '<img src=\"'+m.poster+'\" style=\"width:36px;height:54px;border-radius:5px
" }).join('');",
" document.getElementById('imdb-cat-thumbs').innerHTML = thumbs;",
" var nameStr = d.name ? ' \u2014 ' + d.name : '';",
" status.textContent = d.count + ' items found' + nameStr; status.style.color = " preview.style.display = 'block';",
" } catch(e) {",
" status.textContent = 'Error: ' + e.message; status.style.color = '#e05252';",
" } finally { btn.disabled = false; btn.textContent = 'Preview'; }",
"}",
"function addImdbCatalog() {",
" if (!imdbCatalogPreviewData) return;",
" var name = document.getElementById('imdb-cat-name').value.trim() || 'IMDB List';",
" var type = document.getElementById('imdb-cat-type').value;",
" state.customCatalogs.push({ id: 'imdblist.' + Date.now(), name: name, type: type, path
" document.getElementById('imdb-cat-url').value = '';",
" document.getElementById('imdb-cat-preview').style.display = 'none';",
" document.getElementById('imdb-cat-status').textContent = '\u2713 Added \"' + name + '\
" document.getElementById('imdb-cat-status').style.color = 'var(--gold)';",
" imdbCatalogPreviewData = null;",
" renderCustomCatalogsList();",
"}",
"",
'var(-
// ── TMDB catalog search ──
"var tmdbCatSearchTimer;",
"function debounceTmdbCatSearch(q) {",
" clearTimeout(tmdbCatSearchTimer);",
" if (!q.trim()) { document.getElementById('tmdb-cat-results').innerHTML=''; return; }",
" tmdbCatSearchTimer = setTimeout(function(){ doTmdbCatSearch(q); }, 350);",
"}",
"async function doTmdbCatSearch(q) {",
" var type = document.getElementById('cc-type').value;",
" var box = document.getElementById('tmdb-cat-results');",
" box.innerHTML = '<div class=\"loading-state\" style=\"padding:0.8rem 0\"><div class=\"
" try {",
" var r = await fetch('/api/tmdb-search?q='+encodeURIComponent(q)+'&apiKey='+encodeURI
" var d = await r.json();",
" if (!d.results || !d.results.length) { box.innerHTML='<p style=\"font-size:0.78rem;c
" box.innerHTML = d.results.map(function(s) {",
" var ph = s.poster ? '<img src=\"'+s.poster+'\" style=\"width:28px;height:42px;bord
" return '<div class=\"search-result-item\" style=\"padding:8px 10px\" onclick=\"sel
" ph + '<div><div style=\"font-size:0.82rem;font-weight:600;color:var(--text)\">'+
" }).join('');",
" } catch(e) { box.innerHTML='<p style=\"font-size:0.78rem;color:var(--text-mute);paddin
"}",
"function selectTmdbCatalogItem(tmdbId, name, type) {",
" var catName = document.getElementById('cc-name');",
" if (!catName.value) catName.value = name;",
" var tt = type==='series'?'tv':'movie';",
" var params = { sort_by: document.getElementById('cc-sort').value };",
" var genre = document.getElementById('cc-genre').value;",
" if (genre) params.with_genres = genre;",
" // Build a discover catalog pre-filtered — or a direct single-show catalog",
" // For a single show, we just filter by with_keywords equivalent; use a tmdb ID " // Actually, store as a special path for single-show override",
" state.customCatalogs.push({ id: 'tmdb_single.'+Date.now(), name: catName.value || name
" document.getElementById('cc-name').value = '';",
" document.getElementById('tmdb-cat-results').innerHTML = '';",
" document.getElementById('cc-search').value = '';",
" document.getElementById('custom-catalog-form').classList.remove('open');",
" renderCustomCatalogsList();",
"}",
"",
filter
// ── Search ──
"var searchTimer;",
"function debounceSearch(q) {",
" clearTimeout(searchTimer);",
" if (!q.trim()) { document.getElementById('search-results').classList.remove('visible')
" searchTimer=setTimeout(function(){ doSearch(q); },350);",
"}",
"async function doSearch(q) {",
" var box=document.getElementById('search-results');",
Search
" box.classList.add('visible');",
" box.innerHTML='<div class=\"loading-state\"><div class=\"spinner-light\"></div> " try {",
" var r=await fetch('/api/search?q='+encodeURIComponent(q)+'&apiKey='+encodeURICompone
" var d=await r.json();",
" if (!d.results||!d.results.length) { box.innerHTML='<p style=\"padding:1rem;font-siz
" box.innerHTML=d.results.map(function(s){",
" var ph=s.poster?'<img class=\"search-poster\" src=\"'+s.poster+'\" alt=\"\" " return '<div class=\"search-result-item\" onclick=\"addShowToList('+s.id+',\\'' +
" }).join('');",
" } catch(e) { box.innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">Error sea
"}",
"",
loadin
// ── Add show ──
"function addShowToList(tmdbId, name, poster) {",
" var listId=uid();",
" state.customSeasons.push({ listId:listId, tmdbId:String(tmdbId), tmdbName:name, " document.getElementById('search-results').classList.remove('visible');",
" document.getElementById('series-search').value='';",
" renderCustomSeasonsList();",
" setTimeout(function(){",
" var card=document.getElementById('show-'+listId);",
" if (card) card.classList.add('expanded');",
" },50);",
"}",
"",
tmdbPo
"function getList(listId) { return state.customSeasons.find(function(l){ return l.listId=
"",
"function updateListMeta(listId, field, value) {",
" var list=getList(listId); if (list) list[field]=value;",
" var nameEl=document.getElementById('show-name-display-'+listId);",
" if (nameEl&&list) nameEl.textContent=(list.prefix||'\u2728')+' '+(list.label||'Best Of
"}",
"",
"function removeList(listId) {",
" state.customSeasons=state.customSeasons.filter(function(l){ return l.listId!==listId;
" renderCustomSeasonsList();",
"}",
"",
"function removeEp(listId, idx) {",
" var list=getList(listId); if (!list) return;",
" list.episodes.splice(idx,1);",
" renderListEpisodes(listId);",
" updateEpCount(listId);",
"}",
"",
"function toggleShowCard(listId) {",
" var card=document.getElementById('show-'+listId);",
" if (card) card.classList.toggle('expanded');",
"}",
"",
"function updateEpCount(listId) {",
" var list=getList(listId); if (!list) return;",
" var badge=document.getElementById('ep-count-'+listId);",
" if (badge) {",
" badge.textContent=list.episodes.length+' ep'+(list.episodes.length!==1?'s':'');",
" badge.className='ep-count-badge'+(list.episodes.length>0?' has-eps':'');",
" }",
"}",
"",
to add
// Render just the episode list
"function renderListEpisodes(listId) {",
" var list=getList(listId); if (!list) return;",
" var el=document.getElementById('eplist-'+listId); if (!el) return;",
" if (!list.episodes.length) {",
" el.innerHTML='<li class=\"ep-list-empty\">No episodes yet. Use the tabs above " }",
" el.innerHTML=list.episodes.map(function(ep,i){",
" var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'0');
" var th=ep.still?'<img class=\"ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading=\"laz
" return '<li class=\"ep-item\" data-lid=\"'+listId+'\" data-idx=\"'+i+'\">'+",
" '<span class=\"ep-rank\">'+(i+1)+'</span>'+",
" '<span class=\"ep-drag\" title=\"Drag to reorder\">&#8801;</span>'+",
" th+",
" '<div class=\"ep-info\"><div class=\"ep-label\">S'+sL+'E'+eL+' \u2014 '+esc(ep.nam
" (ep.vote_average>0?'<span class=\"ep-rating\">\u2605'+ep.vote_average.toFixed(1)+'
" '<span class=\"ep-del\" onclick=\"removeEp(\\'' + listId + '\\','+i+')\" title=\"R
" }).join('');",
" initDragSort(listId);",
"}",
"",
// Full re-render of list section
"function renderCustomSeasonsList() {",
" var el=document.getElementById('custom-seasons-list');",
" if (!state.customSeasons.length) { el.innerHTML='<div class=\"empty-state\">No shows y
" el.innerHTML=state.customSeasons.map(function(list){",
" var tid=list.listId;",
" var ph=list.tmdbPoster?'<img class=\"show-poster\" src=\"'+list.tmdbPoster+'\" alt=\
" var displayName=(list.prefix||'\u2728')+' '+(list.label||'Best Of')+' \u2014 '+list.
" var hasCnt=list.episodes.length>0;",
" return '<div class=\"show-card\" id=\"show-'+tid+'\">' +",
" '<div class=\"show-card-header\">'+ph+",
" '<div class=\"show-card-info\"><div class=\"show-card-name\" id=\"show-name-disp
" '<div class=\"show-card-actions\">'+",
" '<span class=\"ep-count-badge'+(hasCnt?' has-eps':'')+' \" id=\"ep-count-'+tid
" '<button class=\"btn btn-ghost btn-sm\" onclick=\"toggleShowCard(\\'' + tid +
" '</div>'+",
" '</div>'+",
" '<div class=\"show-ep-body\">'+",
" '<div style=\"padding:14px 16px 0;\">'+",
" '<div class=\"show-rename-row\">'+",
" '<input class=\"show-rename-prefix\" type=\"text\" value=\"'+esc(list.prefix
" '<input class=\"show-rename-label\" type=\"text\" value=\"'+esc(list.label||
" '<button class=\"btn btn-danger btn-sm\" onclick=\"removeList(\\'' + tid + '
" '</div>'+",
" '</div>'+",
" '<div class=\"add-tabs\">'+",
" '<button class=\"add-tab active\" id=\"add-tab-picker-'+tid+'\" onclick=\"swit
" '<button class=\"add-tab\" id=\"add-tab-imdb-'+tid+'\" onclick=\"switchAddTab(
" '<button class=\"add-tab\" id=\"add-tab-paste-'+tid+'\" onclick=\"switchAddTab
" '</div>'+",
// Picker panel
" '<div class=\"add-panel active\" id=\"add-panel-picker-'+tid+'\">'+",
" '<button class=\"btn btn-ghost btn-sm\" style=\"width:100%\" onclick=\"openMod
" '</div>'+",
// IMDB panel
" '<div class=\"add-panel\" id=\"add-panel-imdb-'+tid+'\">'+",
" '<div class=\"import-row\">'+",
" '<input type=\"text\" id=\"imdb-url-'+tid+'\" placeholder=\"https://www.imdb
" '<button class=\"btn btn-ghost btn-sm\" id=\"imdb-btn-'+tid+'\" onclick=\"im
" '</div>'+",
" '<div class=\"import-status\" id=\"imdb-status-'+tid+'\"></div>'+",
" '</div>'+",
// Paste panel
" '<div class=\"add-panel\" id=\"add-panel-paste-'+tid+'\">'+",
" '<p class=\"paste-hint\">Accepts S01E01, s1e1, 1x01 formats. One per line or s
" '<textarea id=\"paste-input-'+tid+'\" placeholder=\"S01E01\\nS01E05\\nS02E03\"
" '<div class=\"paste-actions\">'+",
" '<button class=\"btn btn-primary btn-sm\" onclick=\"applyPaste(\\'' + " '<span class=\"paste-status\" id=\"paste-status-'+tid+'\"></span>'+",
" '</div>'+",
" '</div>'+",
tid +
// Episode list
" '<div style=\"padding:0 16px 16px;\">'+",
" '<ul class=\"ep-list mt-2\" id=\"eplist-'+tid+'\"><li class=\"ep-list-empty\">
" '</div>'+",
" '</div>'+",
" '</div>';",
" }).join('');",
" state.customSeasons.forEach(function(list){",
" renderListEpisodes(list.listId);",
" initDragSort(list.listId);",
" });",
"}",
"",
// ── Drag sort — works on both desktop (mouse) and mobile (touch) ──
"function initDragSort(listId) {",
" var listEl = document.getElementById('eplist-'+listId);",
" if (!listEl) return;",
"",
" // Desktop drag-and-drop",
" var dragIdx = null;",
" listEl.querySelectorAll('.ep-item').forEach(function(item, idx) {",
" item.setAttribute('draggable', 'true');",
" item.addEventListener('dragstart', function(e) {",
" dragIdx = parseInt(item.dataset.idx);",
" item.classList.add('dragging');",
" e.dataTransfer.effectAllowed = 'move';",
" });",
" item.addEventListener('dragend', function() {",
" item.classList.remove('dragging');",
" listEl.querySelectorAll('.ep-item').forEach(function(i) { i.classList.remove('drag
" });",
" item.addEventListener('dragover', function(e) {",
" e.preventDefault();",
" listEl.querySelectorAll('.ep-item').forEach(function(i) { i.classList.remove('drag
" item.classList.add('drag-over');",
" });",
" item.addEventListener('dragleave', function() { item.classList.remove('drag-over');
" item.addEventListener('drop', function(e) {",
" e.preventDefault();",
" item.classList.remove('drag-over');",
" var dropIdx = parseInt(item.dataset.idx);",
" if (dragIdx === null || dragIdx === dropIdx) return;",
" var list = getList(listId); if (!list) return;",
" var moved = list.episodes.splice(dragIdx, 1)[0];",
" list.episodes.splice(dropIdx, 0, moved);",
" renderListEpisodes(listId);",
" updateEpCount(listId);",
" });",
" });",
"",
" // Touch drag-and-drop for mobile",
" var touchDragIdx = null;",
" var touchClone = null;",
" var touchOffsetY = 0;",
" listEl.querySelectorAll('.ep-drag').forEach(function(handle) {",
" handle.addEventListener('touchstart', function(e) {",
" var item = handle.closest('.ep-item');",
" if (!item) return;",
" touchDragIdx = parseInt(item.dataset.idx);",
" var touch = e.touches[0];",
" var rect = item.getBoundingClientRect();",
" touchOffsetY = touch.clientY - rect.top;",
" touchClone = item.cloneNode(true);",
" touchClone.style.cssText = 'position:fixed;left:'+rect.left+'px;top:'+rect.top+'px
" document.body.appendChild(touchClone);",
" item.style.opacity = '0.3';",
" e.preventDefault();",
" }, { passive: false });",
" handle.addEventListener('touchmove', function(e) {",
" if (touchDragIdx === null || !touchClone) return;",
" var touch = e.touches[0];",
" touchClone.style.top = (touch.clientY - touchOffsetY) + 'px';",
" var targetEl = document.elementFromPoint(touch.clientX, touch.clientY);",
" listEl.querySelectorAll('.ep-item').forEach(function(i) { i.classList.remove('drag
" var targetItem = targetEl ? targetEl.closest('.ep-item') : null;",
" if (targetItem && targetItem.dataset.lid === listId) targetItem.classList.add('dra
" e.preventDefault();",
" }, { passive: false });",
" handle.addEventListener('touchend', function(e) {",
" if (touchDragIdx === null) return;",
" var touch = e.changedTouches[0];",
" var targetEl = document.elementFromPoint(touch.clientX, touch.clientY);",
" var targetItem = targetEl ? targetEl.closest('.ep-item') : null;",
" if (touchClone) { document.body.removeChild(touchClone); touchClone = null; }",
" listEl.querySelectorAll('.ep-item').forEach(function(i) { i.style.opacity=''; i.cl
" if (targetItem && targetItem.dataset.lid === listId) {",
" var dropIdx = parseInt(targetItem.dataset.idx);",
" if (dropIdx !== touchDragIdx) {",
" var list = getList(listId);",
" if (list) {",
" var moved = list.episodes.splice(touchDragIdx, 1)[0];",
" list.episodes.splice(dropIdx, 0, moved);",
" renderListEpisodes(listId);",
" updateEpCount(listId);",
" }",
" }",
" }",
" touchDragIdx = null;",
" });",
" });",
"}",
"",
// ── Modal ──
"async function openModal(listId) {",
" var list=getList(listId); if (!list) return;",
" modalData.listId=listId; modalData.tmdbId=list.tmdbId;",
" modalData.allEpisodes=[]; modalData.filteredSeason='all';",
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
" if (d.error) throw new Error(d.error);",
" modalData.allEpisodes=d.episodes;",
" document.getElementById('modal-show-sub').textContent=d.show.seasons+' season'+(d.sh
" var seasons=[]; d.episodes.forEach(function(e){ if (seasons.indexOf(e.season)===-1)
" var filters=document.getElementById('modal-season-filters');",
" var btns=['<button class=\"season-btn active\" onclick=\"setSeasonFilter(\\'all\\',t
" seasons.forEach(function(s){ btns.push('<button class=\"season-btn\" onclick=\"setSe
" filters.innerHTML=btns.join('');",
" renderModalEpisodes();",
" } catch(e) {",
" document.getElementById('modal-ep-list').innerHTML='<p style=\"padding:1rem;color:va
" }",
"}",
"function setSeasonFilter(val,btn) {",
" modalData.filteredSeason=val;",
" document.querySelectorAll('.season-btn').forEach(function(b){ b.classList.remove('acti
" btn.classList.add('active');",
" renderModalEpisodes();",
"}",
"function renderModalEpisodes() {",
" var eps=modalData.filteredSeason==='all'?modalData.allEpisodes:modalData.allEpisodes.f
" var list=document.getElementById('modal-ep-list');",
" if (!eps.length) { list.innerHTML='<p style=\"padding:1rem;color:var(--text-mute)\">No
" list.innerHTML=eps.map(function(ep){",
" var key=ep.season+':'+ep.episode;",
" var sel=modalData.selected.has(key);",
" var sL=String(ep.season).padStart(2,'0'); var eL=String(ep.episode).padStart(2,'0');
" var th=ep.still?'<img class=\"modal-ep-thumb\" src=\"'+ep.still+'\" alt=\"\" loading
" return '<div class=\"modal-ep-item'+(sel?' selected':'')+' \" onclick=\"toggleEp(\\'
" }).join('');",
"}",
"function toggleEp(key,el) {",
" if (modalData.selected.has(key)){ modalData.selected.delete(key); el.classList.remove(
" else { modalData.selected.add(key); el.classList.add('selected'); el.querySelector('.m
" updateModalCount();",
"}",
"function updateModalCount() { document.getElementById('modal-sel-count').textContent=mod
"function addSelectedEpisodes() {",
" var list=getList(modalData.listId); if (!list){ closeModal(); return; }",
" var keys=Array.from(modalData.selected);",
" var episodes=keys.map(function(k){",
" var p=k.split(':').map(Number);",
" return modalData.allEpisodes.find(function(ep){ return ep.season===p[0]&&ep.episode=
" }).filter(Boolean);",
" var existingKeys=new Set(list.episodes.map(function(e){ return e.season+':'+e.episode;
" var kept=list.episodes.filter(function(e){ return keys.indexOf(e.season+':'+e.episode)
" var newEps=episodes.filter(function(e){ return !existingKeys.has(e.season+':'+e.episod
" list.episodes=kept.concat(newEps);",
" closeModal();",
" renderListEpisodes(modalData.listId);",
" updateEpCount(modalData.listId);",
"}",
"function closeModal(){ document.getElementById('modal-backdrop').classList.remove('open'
"function closeModalOnBackdrop(e){ if(e.target===document.getElementById('modal-backdrop'
"",
// ── IMDB list import for episodes ──
"async function importImdbList(listId) {",
" var list = getList(listId); if (!list) return;",
" var input = document.getElementById('imdb-url-'+listId);",
" var status = document.getElementById('imdb-status-'+listId);",
" var btn = document.getElementById('imdb-btn-'+listId);",
" var url = (input ? input.value : '').trim();",
" if (!url) { if(status){status.textContent='Please enter an IMDB list URL'; status.clas
" if (btn){btn.disabled=true;btn.innerHTML='<span class=\"spinner-light\"></span>';}",
" if (status){status.textContent='Fetching\u2026'; status.className='import-status';}",
" try {",
" var r=await fetch('/api/imdb-list?url='+encodeURIComponent(url)+'&apiKey='+encodeURI
" var d=await r.json();",
" if (d.error) throw new Error(d.error);",
" if (!d.episodes||!d.episodes.length) throw new Error('No matching episodes found for
" var existingKeys=new Set(list.episodes.map(function(e){ return e.season+':'+e.episod
" var allEpsForShow=modalData.tmdbId===list.tmdbId?modalData.allEpisodes:[];",
" var added=0;",
" for (var i=0;i<d.episodes.length;i++){",
" var ref=d.episodes[i]; var key=ref.season+':'+ref.episode;",
" if (!existingKeys.has(key)){",
" existingKeys.add(key);",
" var full=allEpsForShow.find(function(e){ return e.season===ref.season&&e.episode
" list.episodes.push(full||ref); added++;",
" }",
" }",
" var msg='Added '+added+' episode'+(added!==1?'s':'');",
" if (d.skipped) msg+=' ('+d.skipped+' not found)';",
" if (status){status.textContent=msg; status.className='import-status ok';}",
" if (input) input.value='';",
" renderListEpisodes(listId); updateEpCount(listId);",
" } catch(e) {",
" if (status){status.textContent='Error: '+e.message; status.className='import-status
" } finally { if(btn){btn.disabled=false;btn.innerHTML='\u2193 Import';} }",
"}",
"",
// ── Season Zero toggle ──
"function toggleSzeroExpand() {",
" var card = document.getElementById('szero-card');",
" if (card) card.classList.toggle('expanded');",
"}",
"",
prefix
// ── Install page ──
"function buildInstallPage() {",
" var flat=state.customSeasons.map(function(list){",
" return { listId:list.listId, tmdbId:list.tmdbId, label:list.label||'Best Of', " });",
" state.topN=parseInt(document.getElementById('topN').value)||20;",
" state.showAutoSeason=document.getElementById('showAutoSeason').checked;",
" var cfg={tmdbApiKey:state.apiKey, topN:state.topN, showAutoSeason:state.showAutoSeason
" var encoded=btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));",
" var manifestUrl=window.location.origin+'/'+encoded+'/manifest.json';",
" document.getElementById('manifest-url').value=manifestUrl;",
" var listCount=state.customSeasons.length;",
" var showCount=new Set(state.customSeasons.map(function(l){ return l.tmdbId; })).size;"
" var enabledDefaultCount=DEFAULT_CATALOGS.filter(function(d){ var ov=state.catalogEnabl
allThu
" var customCatCount=state.customCatalogs.length;",
" document.getElementById('install-summary').innerHTML=",
" '<div class=\"summary-row\"><span class=\"summary-label\">Default catalogs</span><sp
" '<div class=\"summary-row\"><span class=\"summary-label\">Custom catalogs</span><spa
" '<div class=\"summary-row\"><span class=\"summary-label\">Season Zero</span><span cl
" '<div class=\"summary-row\" style=\"margin-bottom:1.4rem\"><span class=\"summary-lab
" var allThumbs=[];",
" state.customSeasons.forEach(function(list){ list.episodes.forEach(function(ep){ " if (allThumbs.length) {",
" var thumbsHtml=allThumbs.concat(allThumbs).map(function(src){",
" return src?'<img class=\"parade-thumb\" src=\"'+src+'\" alt=\"\" loading=\"lazy\"/
" }).join('');",
" document.getElementById('ep-parade').innerHTML='<div class=\"ep-parade-track\">'+thu
" document.getElementById('ep-parade').style.display='flex';",
" } else {",
" document.getElementById('ep-parade').style.display='none';",
" }",
"}",
"",
"function openStremio(){ var url=document.getElementById('manifest-url').value; if(!url)
"function copyUrl(){",
" var input=document.getElementById('manifest-url');",
" input.select();",
" try{document.execCommand('copy');}catch(e){navigator.clipboard&&navigator.clipboard.wr
" var btn=document.getElementById('copy-btn');",
" btn.textContent='Copied!'; btn.classList.add('copied');",
" setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied');},2000);",
"}",
"",
"function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace
"function esc4attr(s){ return String(s||'').replace(/'/g,'&#39;'); }",
].join('\n');
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
<div class="hero-bg-overlay"></div>
</div>
<div class="hero">
<div class="hero-logo">Good<span>Taste</span></div>
<div class="hero-tagline">The ultimate metadata &amp; curation addon</div>
<div class="hero-features">
<div class="hero-feat">
<strong>Full Metadata &amp; Search</strong>
Rich posters, ratings, cast, trailers &mdash; all sourced from TMDB
</div>
<div class="hero-feat">
<strong>Curated Episode Lists</strong>
Handpick episodes from any series and stream straight from your list
</div>
<div class="hero-feat">
<strong>Catalog Manager</strong>
Create, import, and manage catalogs from TMDB, MDBList, or IMDB
</div>
<div class="hero-feat">
<strong>Season Zero <span class="beta-inline">Beta</span></strong>
Auto-adds the top-rated episodes of every series to a Season 0
</div>
</div>
</div>
</div>
<div class="card">
<div class="card-eyebrow">Step 1 of 4</div>
<div class="card-title">Connect to TMDB</div>
<div class="card-sub">Enter your free TMDB API key to get started. GoodTaste uses TMDB
<div class="field">
<label>TMDB API Key</label>
<input type="password" id="apiKey" placeholder="Paste your key here..." autocomplete=
<p class="hint">Free key at <a href="https://www.themoviedb.org/settings/api" target=
</div>
</div>
</div>
<button class="btn btn-primary btn-lg" style="width:100%" onclick="validateApiKey()" id
<!-- PAGE 2: Curated Lists + Season Zero -->
<div class="page" id="page-2">
<div class="card">
<div class="card-eyebrow">Step 2 of 4</div>
<div class="card-title">Curated Episode Lists</div>
<div class="card-sub">Search for a TV show and build a curated episode list. Each list
<div class="field search-wrap">
<span class="search-icon">&#128269;</span>
<input type="text" id="series-search" placeholder="Search for a TV show..." oninput="
</div>
<div id="search-results" class="search-results"></div>
</div>
<div class="card">
<div class="section-header">
<span class="section-label">Your Lists</span>
</div>
<div id="custom-seasons-list">
<div class="empty-state">No shows yet. Search above to get started.</div>
</div>
</div>
<!-- Season Zero — compact collapsed state -->
<div class="szero-card" id="szero-card">
<div class="szero-header" onclick="toggleSzeroExpand()">
<div class="szero-header-left">
<div>
<div class="szero-title-row">
<span class="szero-title-text">Season Zero</span>
<span class="beta-badge">Beta</span>
</div>
<div class="szero-desc">Auto-adds top-rated episodes of every series to a Season
</div>
</div>
<span class="szero-expand-icon">&#9660;</span>
</div>
<div class="szero-body">
<div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
<div class="field" style="margin-bottom:0;flex:1;min-width:160px">
<label>Top N Episodes</label>
<input type="number" id="topN" placeholder="20" min="5" max="100" value="20"/>
</div>
<div class="catalog-row" style="flex:1;min-width:200px;margin-bottom:0">
<div class="catalog-row-info">
<div style="font-size:0.87rem;font-weight:600;color:var(--text)">Enable Season
<div class="catalog-row-type">Off by default</div>
</div>
<label class="toggle"><input type="checkbox" id="showAutoSeason"/><span class="to
</div>
</div>
<div class="szero-warning">
<strong>Note:</strong> Streaming from Season Zero may not work on all platforms. Fo
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
<div class="card-eyebrow">Step 3 of 4</div>
<div class="card-title">Catalog Manager</div>
<div class="card-sub">Enable or disable default TMDB catalogs, rename them, and add cus
<div class="catalog-group" id="catalog-group-movie">
<div class="catalog-group-header" onclick="toggleCatalogGroup('movie')">
<span class="catalog-section-label">Movies</span>
<span class="catalog-group-chevron">&#9660;</span>
</div>
<div class="catalog-group-body">
<div id="catalog-defaults-movie"></div>
</div>
</div>
<div class="catalog-group" id="catalog-group-series">
<div class="catalog-group-header" onclick="toggleCatalogGroup('series')">
<span class="catalog-section-label">Series</span>
<span class="catalog-group-chevron">&#9660;</span>
</div>
<div class="catalog-group-body">
<div id="catalog-defaults-series"></div>
</div>
</div>
</div>
<div class="card">
<div class="section-header">
<div>
</div>
</div>
<div style="font-size:0.9rem;font-weight:600;color:#fff">Custom Catalogs</div>
<div style="font-size:0.78rem;color:var(--text-mute);margin-top:2px">Add catalogs f
<button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()">+ Add</butto
<div class="custom-catalog-form" id="custom-catalog-form">
<div class="add-cat-tabs">
<button class="add-cat-tab active" id="add-cat-tab-tmdb" onclick="switchAddCatTab('
<button class="add-cat-tab" id="add-cat-tab-mdblist" onclick="switchAddCatTab('mdbl
<button class="add-cat-tab" id="add-cat-tab-imdb" onclick="switchAddCatTab('imdb')"
</div>
<!-- TMDB Discover panel -->
<div class="add-cat-panel active" id="add-cat-panel-tmdb">
<div class="form-row">
<div class="field" style="margin-bottom:0"><label>Catalog Name</label><input type
<div class="field" style="margin-bottom:0"><label>Type</label><select id="cc-type
</div>
<div class="form-row" style="margin-top:10px">
<div class="field" style="margin-bottom:0"><label>Genre</label><select id="cc-gen
<div class="field" style="margin-bottom:0"><label>Sort By</label><select id="cc-s
</div>
<div style="margin-top:10px">
<label style="margin-bottom:6px">Search TMDB (optional — refine by actor, keyword
<input type="text" id="cc-search" placeholder="Search TMDB for movies or shows...
<div id="tmdb-cat-results" style="margin-top:4px"></div>
</div>
<div style="display:flex;gap:8px;margin-top:14px">
<button class="btn btn-primary btn-sm" onclick="addCustomCatalog()">Add Catalog</
<button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()">Cancel</
</div>
</div>
<!-- MDBList panel -->
<div class="add-cat-panel" id="add-cat-panel-mdblist">
<div style="display:flex;gap:8px;margin-bottom:8px">
<input type="text" id="mdb-cat-url" placeholder="https://mdblist.com/lists/userna
<button class="btn btn-ghost btn-sm" id="mdb-cat-btn" onclick="previewMdbCatalog(
</div>
<div id="mdb-cat-status" style="font-size:0.73rem;color:var(--text-mute);min-height
<div id="mdb-cat-preview" style="display:none">
<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:fl
<div class="field" style="margin-bottom:0;flex:1;min-width:160px"><label>Catalo
<div class="field" style="margin-bottom:0;min-width:120px"><label>Type</label><
<button class="btn btn-primary btn-sm" onclick="addMdbCatalog()">Add</button>
</div>
<div id="mdb-cat-thumbs" style="display:flex;gap:6px;overflow:hidden;opacity:0.7"
</div>
<div style="margin-top:10px">
<button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()">Cancel</
</div>
</div>
<!-- IMDB List panel -->
<div class="add-cat-panel" id="add-cat-panel-imdb">
<div style="display:flex;gap:8px;margin-bottom:8px">
<input type="text" id="imdb-cat-url" placeholder="https://www.imdb.com/list/ls086
<button class="btn btn-ghost btn-sm" id="imdb-cat-btn" onclick="previewImdbCatalo
</div>
<div id="imdb-cat-status" style="font-size:0.73rem;color:var(--text-mute);min-heigh
<div id="imdb-cat-preview" style="display:none">
<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:fl
<div class="field" style="margin-bottom:0;flex:1;min-width:160px"><label>Catalo
<div class="field" style="margin-bottom:0;min-width:120px"><label>Type</label><
<button class="btn btn-primary btn-sm" onclick="addImdbCatalog()">Add</button>
</div>
<div id="imdb-cat-thumbs" style="display:flex;gap:6px;overflow:hidden;opacity:0.7
</div>
<div style="margin-top:10px">
<button class="btn btn-ghost btn-sm" onclick="toggleCustomCatalogForm()">Cancel</
</div>
</div>
</div>
<div id="custom-catalogs-list" style="margin-top:12px"><div class="empty-state">No cust
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
<div class="install-hero-title">You have <span>good taste.</span></div>
<div class="install-hero-sub">Add GoodTaste directly to Stremio or copy the manifest
</div>
<div id="ep-parade" class="ep-parade" style="display:none"></div>
<div id="install-summary"></div>
<button class="btn-install" onclick="openStremio()">Open in Stremio</button>
<div class="or-divider">&mdash; or copy the manifest URL &mdash;</div>
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