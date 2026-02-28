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
{ id: 'tmdb.trending_movies', type: 'movie', name: 'TMDB Trending Movies', path: '/tre
{ id: 'tmdb.popular_movies', type: 'movie', name: 'TMDB Popular Movies', path: '/mo
{ id: 'tmdb.top_rated_movies', type: 'movie', name: 'TMDB Top Rated Movies', path: '/mo
{ id: 'tmdb.upcoming_movies', type: 'movie', name: 'TMDB Upcoming Movies', path: '/mo
{ id: 'tmdb.nowplaying_movies', type: 'movie', name: 'TMDB Now Playing Movies', path: '/mo
{ id: 'tmdb.trending_series', type: 'series', name: 'TMDB Trending Series', path: '/tr
{ id: 'tmdb.popular_series', type: 'series', name: 'TMDB Popular Series', path: '/tv
{ id: 'tmdb.top_rated_series', type: 'series', name: 'TMDB Top Rated Series', path: '/tv
{ id: 'tmdb.airing_today', type: 'series', name: 'TMDB Airing Today', path: '/tv
{ id: 'tmdb.on_the_air', type: 'series', name: 'TMDB On The Air', path: '/tv
];
// ─── DATA MODEL ──────────────────────────────────────────────────────────────
// customSeasons is an ARRAY of list objects (supports multiple lists per show):
// [
// {
// listId: 'abc123', // stable unique ID (timestamp-based)
// tmdbId: '1396', // TMDB series ID
// label: 'Essential BB', // display label (shown in catalog)
// prefix: ' ', // emoji/text prepended to the show name
// episodes: [{season, episode}, ...]
// },
// ...
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
return tmdb('/movie/' + tmdbId, apiKey, { append_to_response: 'external_ids,release_dates,c
}
async function getSeries(tmdbId, apiKey) {
return tmdb('/tv/' + tmdbId, apiKey, { append_to_response: 'external_ids,content_ratings,cr
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
// Build videos array for a bestof list entry
// FIX: Use imdbId:season:episode format so stream addons can resolve them.
function buildBestOfVideos(bestOfEps, imdbId, tmdbId) {
return bestOfEps.map(function(ep, i) {
const rank = i + 1;
const sLabel = String(ep.season).padStart(2, '0');
const eLabel = String(ep.episode).padStart(2, '0');
const ratingLine = ep.vote_average > 0
? ep.vote_average.toFixed(1) + '/10 (' + ep.vote_count.toLocaleString() + ' votes)\n\n
// Prefer IMDB id format (tt1234:S:E) — stream addons expect this.
// Fall back to tmdb: prefix only when no IMDB id is available.
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
const customSeasons = cfg.customSeasons || []; // now an array
const allCatalogs = [
...enabledDefaults.map(d => ({
id: d.id, type: d.type, name: d.name,
// Do NOT include search here — regular catalogs don't support it.
// If search is declared as optional, Stremio will query these catalogs
// during a search and they'll return unrelated trending/popular results.
extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }],
})),
...customCatalogs.map(c => ({
id: c.id, type: c.type, name: c.name,
extra: [{ name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }],
})),
{ id: 'tmdb.search_movies', type: 'movie', name: 'TMDB Search Movies', extra: [{ name:
{ id: 'tmdb.search_series', type: 'series', name: 'TMDB Search Series', extra: [{ name:
];
// One catalog entry per custom list (supports multiple lists per show)
if (customSeasons.length > 0) {
allCatalogs.push({ id: 'tmdb.bestof', type: 'series', name: '\u2b50 Best Of', extra: [] }
}
return {
id: 'community.tmdb-metadata-bestof',
version: '4.0.0',
name: 'TMDB Metadata + Best Of',
description: 'Full TMDB metadata, catalogs, and search. Custom Best Of lists with IMDB im
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
const prefix = list.prefix || '\u2b50';
const label = list.label || 'Best Of';
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
// FIX: Parse extras robustly — Stremio may send them as key=value pairs
// separated by & and the whole string may or may not be URL-encoded.
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
// FIX: search queries can be double-encoded; normalise
const search = extrasMap.search ? extrasMap.search.trim() : null;
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
const customDef = (cfg.customCatalogs || []).find(c => c.id === id);
const catDef = defaultDef || customDef;
if (!catDef) return res.json({ metas: [] });
// If Stremio somehow still sends a search query to a regular catalog, bail out.
// Regular catalogs don't support search — returning results here pollutes the
// search UI with trending/popular noise before the actual search results appear.
if (search) return res.json({ metas: [] });
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
// ─── AI PROMPT ENDPOINT ───────────────────────────────────────────────────────
// Tries Gemini (free tier) with user key if supplied, otherwise falls back to
// Pollinations.ai which provides free, no-key-required LLM inference.
// Returns { episodes: [{season,episode},...], raw: '...', error?: '...' }
app.post('/api/ai-prompt', async function(req, res) {
const { showName, focus, count, geminiKey } = req.body || {};
if (!showName || !focus) return res.status(400).json({ error: 'showName and focus are requi
+ '.',
const n = parseInt(count) || null;
const prompt = [
'Research and provide a list of' + (n ? ' ' + n : '') + ' episodes of ' + showName 'The list should focus on the following: ' + focus + '.',
'Reply in a list formatted S#E# one on each line. Do not provide any additional text, sou
].join(' ');
// ── Try Gemini first (free tier) if key is supplied ────────────────────────
if (geminiKey && geminiKey.trim()) {
try {
const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-f
const geminiBody = {
contents: [{ parts: [{ text: prompt }] }],
generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
};
const { data } = await axios.post(geminiUrl, geminiBody, { timeout: 20000 });
const text = ((data.candidates || [])[0] || {}).content &&
data.candidates[0].content.parts &&
data.candidates[0].content.parts[0] &&
data.candidates[0].content.parts[0].text || '';
if (text) {
const episodes = parseEpisodeCodes(text);
return res.json({ episodes, raw: text, source: 'gemini' });
}
} catch (e) {
console.warn('[ai-prompt] Gemini failed:', e.message, '— falling back to Pollinations')
}
}
// ── Free fallback: Pollinations.ai text endpoint (no key needed) ─────────
try {
const pollinationsUrl = 'https://text.pollinations.ai/' + encodeURIComponent(prompt) + '?
const { data: rawText } = await axios.get(pollinationsUrl, { timeout: 25000, responseType
const text = String(rawText || '').trim();
if (!text) throw new Error('Empty response from Pollinations');
const episodes = parseEpisodeCodes(text);
return res.json({ episodes, raw: text, source: 'pollinations' });
} catch (e) {
console.error('[ai-prompt] Pollinations failed:', e.message);
return res.status(500).json({ error: 'AI request failed: ' + e.message });
}
});
function parseEpisodeCodes(text) {
const re = /[Ss](\d{1,3})[Ee](\d{1,3})|(?:^|\D)(\d{1,2})[Xx](\d{1,3})(?:\D|$)/gm;
const results = [];
const seen = new Set();
let m;
while ((m = re.exec(text)) !== null) {
const s = parseInt(m[1] || m[3]);
const e = parseInt(m[2] || m[4]);
if (!isNaN(s) && !isNaN(e) && s > 0 && e > 0) {
const key = s + ':' + e;
if (!seen.has(key)) { seen.add(key); results.push({ season: s, episode: e }); }
}
}
return results;
}
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
headers: {
'Accept': 'text/csv,text/plain,*/*',
'Accept-Language': 'en-US,en;q=0.9',
'User-Agent': UA,
},
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
headers: {
'Accept': 'text/html,*/*',
'Accept-Language': 'en-US,en;q=0.9',
'User-Agent': UA,
},
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
try {
csvText = await fetchImdbCsvExport();
} catch (e) {
csvText = null;
}
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
return res.json({ episodes: [], errors: [{ reason: 'No IMDb title IDs found in list (ex
}
const results = [];
const errors = [];
for (const ttId of ttIds) {
try {
const found = await tmdb('/find/' + ttId, apiKey, { external_source: 'imdb_id' const epResults = found.tv_episode_results || [];
if (epResults.length > 0) {
});
const matches = epResults.filter(ep => String(ep.show_id) === String(tmdbId));
if (matches.length > 0) {
for (const ep of matches) {
results.push({ season: ep.season_number, episode: ep.episode_number });
}
} else {
errors.push({ ttId, reason: 'Episode belongs to a different show (show_id=' + Str
}
} else {
const tvRes = (found.tv_results || []).length;
const mvRes = (found.movie_results || []).length;
if (tvRes || mvRes) {
errors.push({ ttId, reason: 'TMDB found non-episode result (tv_results=' + } else {
errors.push({ ttId, reason: 'Not found as TV episode on TMDB' });
}
tvRes
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
// ── bestof: handler ───────────────────────────────────────────────────────
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
const videos const startYear = buildBestOfVideos(bestOfEps, imdbId, list.tmdbId);
= series.first_air_date ? series.first_air_date.substring(0, 4) : '';
const endYear = series.last_air_date ? series.last_air_date.substring(0, 4) : ''
const releaseInfo = series.status === 'Ended' && endYear ? startYear + '-' + endYear :
const prefix = list.prefix || '\u2b50';
const label = list.label || 'Best Of';
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
// ── regular tmdb: series ──────────────────────────────────────────────────
if (!id.startsWith('tmdb:')) return res.json({ meta: null });
const tmdbId = extractId(id);
const topN = parseInt(cfg.topN) || 20;
try {
const series = await getSeries(tmdbId, cfg.tmdbApiKey);
const cert = getSeriesCert(series);
const cast = (series.credits && series.credits.cast || []).slice(0, 8).map(c => c.name)
// FIX: Use IMDB id in video IDs so that stream addons (torrentio etc.) can
// resolve streams. Format: ttXXXXX:season:episode
// Fall back to tmdb: prefix only when no external IMDB id is available.
const imdbId = series.external_ids && series.external_ids.imdb_id || null;
const videos = [];
for (let s = 1; s <= (series.number_of_seasons || 0); s++) {
try {
const season = await getSeason(tmdbId, s, cfg.tmdbApiKey);
for (const ep of (season.episodes || [])) {
// KEY FIX: video id uses imdbId when available so streams resolve correctly
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
const bestOfEps = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons
bestOfEps.forEach((ep, i) => {
const rank = i + 1;
const sLabel = String(ep.season).padStart(2, '0');
const eLabel = String(ep.episode).padStart(2, '0');
const ratingLine = ep.vote_average > 0
? ep.vote_average.toFixed(1) + '/10 (' + ep.vote_count.toLocaleString() + ' // Season 0 pseudo-episodes use a stable tmdb: id so episodeVideos can remap them
votes)
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
: '';
const startYear = series.first_air_date ? series.first_air_date.substring(0, 4) : '';
const endYear = series.last_air_date ? series.last_air_date.substring(0, 4) const releaseInfo = series.status === 'Ended' && endYear ? startYear + '-' + endYear : st
res.json({ meta: {
id, type: 'series', name: series.name,
poster: series.poster_path ? TMDB_IMG_MD + series.poster_path : null,
background: series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
description: series.overview, releaseInfo, videos,
runtime: series.episode_run_time && series.episode_run_time[0] ? series.episode_r
genres: (series.genres || []).map(g => g.name),
imdbRating: series.vote_average ? series.vote_average.toFixed(1) : null,
cast, certification: cert || null,
links: imdbId
? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' + imdbId }] :
}});
} catch (e) {
console.error('[series meta]', e.message);
res.status(500).json({ err: e.message });
}
});
// ─── EPISODE VIDEOS ───────────────────────────────────────────────────────────
// Only needed for Season 0 auto-best-of pseudo-episodes (remaps to real episode id)
app.get('/:config/episodeVideos/series/:id.json', async function(req, res) {
const cfg = parseConfig(req.params.config);
const id = req.params.id;
if (!cfg.tmdbApiKey) return res.json({ videos: [] });
const parts = id.split(':');
// Only handle Season 0 auto-best-of via tmdb: prefix
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
// FIX: return the real episode id so stream addons can resolve it
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
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
--bg: #080b10; --surface: #0e1219; --surface2: #131820;
--border: #1e2530; --border2: #2a3340;
--text: #c8d4e0; --text-dim: #5a6878; --text-mute: #3a4555;
--accent: #3d9be9; --accent2: #56cfb0; --gold: #f0b429;
--purple: #8b5cf6; --danger: #e05252; --radius: 12px;
--beta: #f59e0b;
}
body { background: var(--bg); color: var(--text); font-family: "DM Sans", sans-serif; min
.app { display: flex; flex-direction: column; min-height: 100vh; }
/* ── Topbar: responsive ── */
.topbar {
background: var(--surface); border-bottom: 1px solid var(--border);
padding: 0 1.5rem; height: 56px; display: flex; align-items: center; gap: 1rem;
position: sticky; top: 0; z-index: 100; overflow: hidden;
}
.topbar-logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size:
.topbar-steps { display: flex; align-items: center; gap: 0; margin-left: auto; overflow:
.step-item {
display: flex; align-items: center; gap: 6px; font-size: 0.75rem;
color: var(--text-dim); padding: 5px 10px; white-space: nowrap; flex-shrink: 0;
}
.step-item.active { color: var(--accent); }
.step-item.done { color: var(--accent2); }
.step-label { display: inline; }
.step-num {
width: 20px; height: 20px; border-radius: 50%; background: var(--surface2);
border: 1.5px solid var(--border2); display: flex; align-items: center;
justify-content: center; font-size: 0.68rem; font-weight: 700; flex-shrink: 0;
}
.step-item.active .step-num { background: var(--accent); border-color: var(--accent); col
.step-item.done .step-num { background: var(--accent2); border-color: var(--accent2); c
.step-divider { color: var(--text-mute); font-size: 0.68rem; flex-shrink: 0; }
@media (max-width: 540px) {
.topbar { padding: 0 1rem; height: 52px; }
.step-label { display: none; }
.step-item { padding: 5px 6px; gap: 0; }
.step-divider { padding: 0 2px; }
}
.main { flex: 1; padding: 2rem 1.5rem; max-width: 820px; margin: 0 auto; width: 100%; }
@media (max-width: 540px) { .main { padding: 1.25rem 0.9rem; } }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 18px;
.card-title { font-size: 1rem; font-weight: 700; color: #fff; margin-bottom: 0.25rem; }
.card-sub { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 1.5rem; }
.field { margin-bottom: 1.2rem; }
label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-dim); mar
input[type=text], input[type=number], input[type=password], textarea {
width: 100%; background: var(--bg); border: 1.5px solid var(--border2);
border-radius: var(--radius); padding: 11px 14px; color: var(--text);
font-size: 0.93rem; font-family: inherit; outline: none; transition: border-color 0.15s
}
textarea { resize: vertical; min-height: 80px; line-height: 1.5; }
select {
width: 100%; background: var(--bg); border: 1.5px solid var(--border2);
border-radius: var(--radius); padding: 11px 14px; color: var(--text);
font-size: 0.93rem; font-family: inherit; outline: none; transition: border-color 0.15s
}
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
input.error, textarea.error { border-color: var(--danger) !important; animation: shake 0.
@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{t
.hint { font-size: 0.72rem; color: var(--text-mute); margin-top: 5px; }
.hint a { color: var(--accent); text-decoration: none; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padd
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.85; }
.btn-secondary { background: var(--surface2); border: 1.5px solid var(--border2); color:
.btn-secondary:hover { border-color: var(--accent); color: var(--accent); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover { opacity: 0.85; }
.btn-gold { background: var(--gold); color: #000; }
.btn-gold:hover { opacity: 0.85; }
.btn-install { background: var(--purple); color: #fff; width: 100%; font-size: 1rem; pa
.btn-install:hover { opacity: 0.85; }
.btn-lg { padding: 13px 28px; font-size: 0.95rem; }
.btn-sm { padding: 6px 12px; font-size: 0.75rem; }
.page { display: none; }
.page.active { display: block; }
.features-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom:
.feature-chip { background: var(--surface2); border: 1px solid var(--border); border-radi
@media (max-width: 540px) { .features-grid { grid-template-columns: 1fr; } }
.beta-badge { display: inline-flex; align-items: center; gap: 4px; background: rgba(245,1
.section-header { display: flex; align-items: center; justify-content: space-between; mar
.section-title { font-size: 0.82rem; font-weight: 700; color: var(--text-dim); text-tran
.search-wrap { position: relative; }
.search-wrap input { padding-left: 42px; }
.search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); col
.search-results { margin-top: 10px; display: none; }
.search-results.visible { display: block; }
.search-result-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px;
.search-result-item:hover { background: var(--surface2); border-color: var(--border); }
.search-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; backgr
.search-name { font-size: 0.88rem; font-weight: 600; color: var(--text); }
.search-meta { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }
.custom-seasons-empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-mute)
.list-card { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; marg
.list-card-header { display: flex; align-items: center; gap: 14px; padding: 14px 16px; cu
.list-card-header:hover { background: var(--bg); }
.list-poster { width: 32px; height: 48px; border-radius: 5px; object-fit: cover; backgrou
.list-card-meta { flex: 1; min-width: 0; }
.list-card-name { font-size: 0.9rem; font-weight: 700; color: #fff; white-space: nowrap;
.list-card-sub { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }
.list-card-count { font-size: 0.72rem; color: var(--text-dim); flex-shrink: 0; }
.list-card-chevron { color: var(--text-mute); transition: transform 0.2s; font-size: 0.8r
.list-card.open .list-card-chevron { transform: rotate(90deg); }
.list-card-body { display: none; border-top: 1px solid var(--border); padding: 14px 16px;
.list-card.open .list-card-body { display: block; }
.list-meta-row { display: flex; gap: 8px; margin-bottom: 12px; align-items: flex-end; fle
.list-meta-row .field { margin-bottom: 0; flex: 1; min-width: 120px; }
.prefix-field { max-width: 90px; flex: 0 0 90px !important; min-width: 0 !important; }
.ep-list { list-style: none; min-height: 40px; }
.ep-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radi
.ep-item.dragging { opacity: 0.45; background: var(--bg); }
.ep-item.drag-over { border-color: var(--accent); }
.ep-rank { width: 22px; text-align: center; flex-shrink: 0; font-size: 0.72rem; color: v
.ep-drag { color: var(--text-mute); flex-shrink: 0; }
.ep-thumb { width: 56px; height: 32px; border-radius: 4px; object-fit: cover; flex-shrink
.ep-info { flex: 1; min-width: 0; }
.ep-label { font-size: 0.8rem; font-weight: 600; color: var(--text); white-space: nowrap;
.ep-sublabel { font-size: 0.68rem; color: var(--text-dim); margin-top: 2px; }
.ep-rating { font-size: 0.72rem; color: var(--gold); font-family: "DM Mono", monospace; f
.ep-del { flex-shrink: 0; color: var(--text-mute); cursor: pointer; font-size: 1rem; pa
.ep-del:hover { color: var(--danger); }
.ep-list-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
/* ── Episode add tabs ── */
.ep-add-section { margin-bottom: 14px; border: 1px solid var(--border); border-radius: 12
.ep-add-tabs { display: flex; border-bottom: 1px solid var(--border); }
.ep-add-tab { flex: 1; padding: 9px 8px; font-size: 0.75rem; font-weight: 600; text-align
.ep-add-tab:last-child { border-right: none; }
.ep-add-tab.active { background: var(--surface); color: var(--accent); }
.ep-add-tab:hover:not(.active) { color: var(--text); }
.ep-add-panel { display: none; padding: 12px 14px; background: var(--surface); }
.ep-add-panel.active { display: block; }
/* Paste panel */
.paste-hint { font-size: 0.72rem; color: var(--text-mute); margin-bottom: 8px; }
.paste-actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap
.paste-status { font-size: 0.75rem; margin-left: auto; }
.paste-status.ok { color: var(--accent2); }
.paste-status.err { color: var(--danger); }
/* AI panel */
.ai-tab-active { background: var(--surface); color: var(--purple) !important; }
.ep-add-tab.ai-active { color: var(--purple); background: var(--surface); }
.ai-panel-inner { display: flex; flex-direction: column; gap: 9px; }
.ai-row { display: flex; gap: 8px; align-items: flex-end; }
.ai-row .field { margin-bottom: 0; flex: 1; }
.ai-count-field { max-width: 80px; flex: 0 0 80px !important; }
.ai-status { font-size: 0.75rem; min-height: 18px; }
.ai-status.ok { color: var(--accent2); }
.ai-status.err { color: var(--danger); }
.ai-status.loading { color: var(--text-dim); }
.ai-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ai-raw-out { font-size: 0.72rem; font-family: "DM Mono", monospace; color: var(--text-di
.ai-raw-out.visible { display: block; }
.ai-source-badge { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.06em; text-tra
.ai-source-badge.gemini { background: rgba(66,133,244,0.15); color: #4285f4; border: 1px
.ai-source-badge.pollinations { background: rgba(86,207,176,0.15); color: var(--accent2);
.gemini-key-hint { font-size: 0.72rem; color: var(--text-mute); margin-top: 4px; }
.gemini-key-hint a { color: var(--accent); text-decoration: none; }
/* IMDB panel */
.imdb-import-row { display: flex; gap: 8px; }
.imdb-import-row input { flex: 1; font-size: 0.82rem; }
.imdb-import-status { font-size: 0.75rem; margin-top: 6px; color: var(--text-dim); .imdb-import-status.ok { color: var(--accent2); }
.imdb-import-status.err { color: var(--danger); }
min-he
.catalog-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-
.catalog-row-info { flex: 1; }
.catalog-row-name { font-size: 0.86rem; font-weight: 600; color: var(--text); }
.catalog-row-type { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; }
.toggle { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle-slider { position: absolute; inset: 0; background: var(--border2); border-radius:
.toggle-slider::before { content: ''; position: absolute; width: 16px; height: 16px; left
.toggle input:checked + .toggle-slider { background: var(--accent); }
.toggle input:checked + .toggle-slider::before { transform: translateX(16px); }
.catalog-section-label { font-size: 0.72rem; font-weight: 700; color: var(--text-mute); t
.custom-catalog-form { background: var(--surface2); border: 1px solid var(--border2); bor
.custom-catalog-form.open { display: block; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 480px) { .form-row { grid-template-columns: 1fr; } }
.custom-catalog-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
.custom-catalog-item-info { flex: 1; }
.custom-catalog-item-name { font-size: 0.86rem; font-weight: 600; color: var(--text); }
.custom-catalog-item-sub { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; f
/* ── Auto Best Of config card ── */
.bestof-auto-card { background: rgba(240,180,41,0.05); border: 1px solid rgba(240,180,41,
.bestof-auto-title { font-size: 0.9rem; font-weight: 700; color: var(--gold); margin-bott
.bestof-auto-desc { font-size: 0.78rem; color: var(--text-dim); margin-bottom: 14px; lin
.bestof-auto-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.bestof-auto-row .field { margin-bottom: 0; flex: 1; min-width: 140px; }
.modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75);
.modal-backdrop.open { display: flex; }
.modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 20p
.modal-header { padding: 1.4rem 1.6rem 1rem; border-bottom: 1px solid var(--border); disp
.modal-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; backgro
.modal-title { font-size: 1rem; font-weight: 700; color: #fff; }
.modal-sub { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }
.modal-close { margin-left: auto; color: var(--text-mute); cursor: pointer; font-size: 1
.modal-close:hover { color: var(--text); }
.modal-filter { padding: 12px 1.6rem; border-bottom: 1px solid var(--border); display: fl
.season-filter-btn { padding: 5px 13px; border-radius: 20px; font-size: 0.75rem; font-wei
.season-filter-btn.active { background: var(--accent); border-color: var(--accent); color
.modal-ep-list { flex: 1; overflow-y: auto; padding: 10px 1.6rem; }
.modal-ep-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; .modal-ep-item:hover { background: var(--surface2); }
.modal-ep-item.selected { border-color: var(--accent); }
.modal-ep-thumb { width: 64px; height: 36px; border-radius: 5px; object-fit: cover; backg
.modal-ep-info { flex: 1; min-width: 0; }
.modal-ep-name { font-size: 0.82rem; font-weight: 600; color: var(--text); white-space:
.modal-ep-meta { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; }
.modal-ep-check { width: 20px; height: 20px; border-radius: 6px; border: 2px solid .modal-ep-item.selected .modal-ep-check { background: var(--accent); border-color: .modal-footer { padding: 1rem 1.6rem; border-top: 1px solid var(--border); display: flex;
border
var(--
var(--
.modal-selected-count { font-size: 0.8rem; color: var(--text-dim); }
paddin
font-s
.generate-hero { text-align: center; padding: 1.2rem 0 2rem; }
.generate-hero h2 { font-size: 1.3rem; font-weight: 700; color: #fff; margin-bottom: 6px;
.generate-hero p { font-size: 0.83rem; color: var(--text-dim); }
.summary-row { display: flex; align-items: center; justify-content: space-between; .summary-label { color: var(--text-dim); }
.summary-value { color: #fff; font-weight: 600; font-family: "DM Mono", monospace; .summary-value.accent { color: var(--accent); }
.summary-value.gold { color: var(--gold); }
.or-line { text-align: center; font-size: 0.72rem; color: var(--text-mute); margin: 14px
.copy-row { display: flex; gap: 8px; }
.copy-row input { flex: 1; font-size: 0.73rem; color: var(--text-dim); padding: 9px 12px;
.btn-copy { flex-shrink: 0; padding: 9px 16px; background: var(--surface2); border: 1.5px
.btn-copy:hover { border-color: var(--accent); color: var(--accent); }
.btn-copy.copied { border-color: var(--accent2); color: var(--accent2); }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,2
@keyframes spin { to { transform: rotate(360deg); } }
.loading-overlay { display: flex; align-items: center; justify-content: center; gap: 10px
.nav-row { display: flex; justify-content: space-between; align-items: center; margin-top
`;
5=Inst
// ── Client JS ──────────────────────────────────────────────────────────────
const clientJS = [
"var DEFAULT_CATALOGS = " + defaultCatalogsJson + ";",
"var state = { apiKey: '', topN: 20, showAutoSeason: true, customSeasons: [], catalogEnab
"var modalData = { listId: null, tmdbId: null, tmdbName: null, tmdbPoster: null, allEpiso
"var genreCache = { movie: null, tv: null };",
// Total pages is now 5: 1=API Key, 2=Best Of Config, 3=Catalogs, 4=Best Of Lists, "var TOTAL_PAGES = 5;",
"",
"function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
"",
"function goTo(n) {",
" document.querySelectorAll('.page').forEach(function(p, i) { p.classList.toggle('active
" document.querySelectorAll('[id^=step-tab-]').forEach(function(el, i) {",
" var num = i + 1; el.classList.remove('active', 'done');",
" if (num === n) el.classList.add('active');",
" else if (num < n) el.classList.add('done');",
" });",
" if (n === TOTAL_PAGES) buildInstallPage();",
" window.scrollTo({ top: 0, behavior: 'smooth' });",
"}",
"",
"async function validateApiKey() {",
" var input = document.getElementById('apiKey');",
" var key = input.value.trim();",
" var btn = document.getElementById('btn-validate');",
" if (!key) { flashError(input); return; }",
" btn.innerHTML = '<span class=\"spinner\"></span> Validating...';",
" btn.disabled = true;",
" try {",
" var r = await fetch('/api/search?q=test&apiKey=' + encodeURIComponent(key));",
" var d = await r.json();",
" if (d.error) throw new Error(d.error);",
" state.apiKey = key;",
" state.geminiKey = (document.getElementById('geminiKey') || {}).value || '';",
// Read Auto Best Of settings from page 1 inputs
" state.topN = parseInt(document.getElementById('topN').value) || 20;",
" state.showAutoSeason = document.getElementById('showAutoSeason').checked;",
" renderDefaultCatalogs();",
" goTo(2);",
" } catch(e) {",
" flashError(input); input.placeholder = 'Invalid API key \u2014 try again';",
" } finally { btn.innerHTML = 'Continue &rarr;'; btn.disabled = false; }",
"}",
"",
"function flashError(el) { el.classList.add('error'); el.focus(); setTimeout(function() {
"",
// ── Tab switching for episode add panels ──────────────────────────────────
"function switchEpTab(listId, tab) {",
" ['picker','imdb','paste','ai'].forEach(function(t) {",
" var btn = document.getElementById('ep-tab-' + t + '-' + listId);",
" var panel = document.getElementById('ep-panel-' + t + '-' + listId);",
" if (btn) btn.classList.toggle('active', t === tab);",
" if (panel) panel.classList.toggle('active', t === tab);",
" });",
"}",
"",
// ── AI Prompt ─────────────────────────────────────────────────────────────
"function buildAiPromptText(showName, focus, count) {",
" var n = (count && parseInt(count) > 0) ? parseInt(count) : null;",
" return 'Research and provide a list of' + (n ? ' ' + n : '') + ' episodes of ' + showN
"}",
"",
"function copyAiPrompt(listId) {",
" var list = getList(listId);",
" if (!list) return;",
" var focus = (document.getElementById('ai-focus-' + listId) || {}).value || '';",
" var count = (document.getElementById('ai-count-' + listId) || {}).value || '';",
" var text = buildAiPromptText(list.tmdbName, focus || '[describe what you want]', count
" try { navigator.clipboard.writeText(text); } catch(e) { /* fallback */ }",
" var btn = document.getElementById('ai-copy-btn-' + listId);",
" if (btn) { var orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(functio
"}",
"",
"async function runAiPrompt(listId) {",
" var list = getList(listId);",
" if (!list) return;",
" var focusEl = document.getElementById('ai-focus-' + listId);",
" var countEl = document.getElementById('ai-count-' + listId);",
" var statusEl = document.getElementById('ai-status-' + listId);",
" var rawEl = document.getElementById('ai-raw-' + listId);",
" var btn = document.getElementById('ai-gen-btn-' + listId);",
" var focus = focusEl ? focusEl.value.trim() : '';",
" var count = countEl ? countEl.value.trim() : '';",
" if (!focus) {",
" focusEl && focusEl.classList.add('error');",
" setTimeout(function(){ focusEl && focusEl.classList.remove('error'); }, 1500);",
" return;",
" }",
" if (btn) { btn.disabled = true; btn.innerHTML = '<span class=\"spinner\"></span> Gener
" if (statusEl) { statusEl.textContent = 'Asking AI\u2026'; statusEl.className = 'ai-sta
" if (rawEl) { rawEl.textContent = ''; rawEl.classList.remove('visible'); }",
" try {",
" var body = JSON.stringify({ showName: list.tmdbName, focus: focus, count: count || '
" var r = await fetch('/api/ai-prompt', { method: 'POST', headers: { 'Content-Type': '
" var d = await r.json();",
" if (d.error) throw new Error(d.error);",
" if (!d.episodes || !d.episodes.length) throw new Error('AI returned no episode codes
// Merge with existing episodes, enrich from TMDB cache where possible
" var allEps = (modalData.tmdbId === list.tmdbId) ? modalData.allEpisodes : [];",
" var existingKeys = new Set(list.episodes.map(function(e) { return e.season + ':' + e
" var added = 0;",
" for (var i = 0; i < d.episodes.length; i++) {",
" var ref = d.episodes[i];",
" var key = ref.season + ':' + ref.episode;",
" if (!existingKeys.has(key)) {",
" existingKeys.add(key);",
" var full = allEps.find(function(e) { return e.season === ref.season && e.episode
" list.episodes.push(full || ref);",
" added++;",
" }",
" }",
" var srcBadge = d.source === 'gemini'",
" ? '<span class=\"ai-source-badge gemini\">Gemini</span>'",
" : '<span class=\"ai-source-badge pollinations\">Free AI</span>';",
" var msg = 'Added ' + added + ' of ' + d.episodes.length + ' episode' + (d.episodes.l
" if (statusEl) { statusEl.innerHTML = msg; statusEl.className = 'ai-status ok'; }",
" if (rawEl && d.raw) { rawEl.textContent = d.raw.trim(); rawEl.classList.add('visible
if (ca
" renderCustomSeasonsList();",
" setTimeout(function() { var card = document.getElementById('card-' + listId); " } catch(e) {",
" if (statusEl) { statusEl.textContent = 'Error: ' + e.message; statusEl.className = '
" } finally {",
" if (btn) { btn.disabled = false; btn.textContent = 'Generate'; }",
" }",
"}",
"",
// ── Paste episode list ─────────────────────────────────────────────────────
// Parses SxEx, S01E01, SE1E1 etc. formats
"function parsePasteEpisodes(text) {",
" var results = [];",
// Match patterns: S1E1, S01E01, s1e1, 1x01, 1X01
" var re = /[Ss](\\d{1,3})[Ee](\\d{1,3})|(?:^|\\D)(\\d{1,2})[Xx](\\d{1,3})(?:\\D|$)/gm;"
" var m;",
" while ((m = re.exec(text)) !== null) {",
" var s = parseInt(m[1] || m[3]);",
" var e = parseInt(m[2] || m[4]);",
" if (!isNaN(s) && !isNaN(e) && s > 0 && e > 0) results.push({ season: s, episode: e }
" }",
// Deduplicate
" var seen = new Set();",
" return results.filter(function(ep) {",
" var k = ep.season + ':' + ep.episode;",
" if (seen.has(k)) return false;",
" seen.add(k); return true;",
" });",
"}",
"",
"function applyPaste(listId) {",
" var textarea = document.getElementById('paste-input-' + listId);",
" var status = document.getElementById('paste-status-' + listId);",
" if (!textarea || !status) return;",
" var text = textarea.value.trim();",
" if (!text) { status.textContent = 'Paste some episode codes first'; status.className =
" var parsed = parsePasteEpisodes(text);",
" if (!parsed.length) { status.textContent = 'No episode codes found. Use S01E01 or 1x01
" var list = getList(listId);",
" if (!list) return;",
// Try to match against cached episodes if available; otherwise store bare refs
" var allEps = (modalData.tmdbId === list.tmdbId) ? modalData.allEpisodes : [];",
" var existingKeys = new Set(list.episodes.map(function(e) { return e.season + ':' + e.e
" var added = 0;",
" for (var i = 0; i < parsed.length; i++) {",
" var ref = parsed[i];",
" var key = ref.season + ':' + ref.episode;",
" if (!existingKeys.has(key)) {",
" existingKeys.add(key);",
" var full = allEps.find(function(e) { return e.season === ref.season && e.episode =
" list.episodes.push(full || ref);",
" added++;",
" }",
" }",
" var msg = 'Added ' + added + ' of ' + parsed.length + ' episode' + (parsed.length !==
" status.textContent = msg;",
" status.className = 'paste-status ok';",
" textarea.value = '';",
" renderCustomSeasonsList();",
" setTimeout(function() { var card = document.getElementById('card-' + listId); if (card
"}",
"",
// ── Catalog UI ──────────────────────────────────────────────────────────
"function renderDefaultCatalogs() {",
" ['movie', 'series'].forEach(function(type) {",
" var el = document.getElementById('catalog-defaults-' + type);",
" var cats = DEFAULT_CATALOGS.filter(function(c) { return c.type === type; });",
" el.innerHTML = cats.map(function(c) {",
" var checked = state.catalogEnabled[c.id] !== undefined ? state.catalogEnabled[c.id
" return '<div class=\"catalog-row\"><div class=\"catalog-row-info\"><div class=\"ca
" }).join('');",
" });",
"}",
"function setCatalogEnabled(id, val) { state.catalogEnabled[id] = val; }",
"",
"function toggleCustomCatalogForm() {",
" var form = document.getElementById('custom-catalog-form');",
" form.classList.toggle('open');",
" if (form.classList.contains('open')) loadGenresForCustom();",
"}",
"async function loadGenresForCustom() {",
" var type = document.getElementById('cc-type').value;",
" var tmdbType = type === 'series' ? 'tv' : 'movie';",
" if (genreCache[tmdbType]) { populateGenreSelect(genreCache[tmdbType]); return; }",
" try {",
" var r = await fetch('/api/genres?apiKey=' + encodeURIComponent(state.apiKey) + '&typ
" var d = await r.json();",
" genreCache[tmdbType] = d.genres || [];",
" populateGenreSelect(genreCache[tmdbType]);",
" } catch(e) {}",
"}",
"function populateGenreSelect(genres) {",
" var sel = document.getElementById('cc-genre');",
" sel.innerHTML = '<option value=\"\">Any Genre</option>' + genres.map(function(g) { ret
"}",
"function addCustomCatalog() {",
" var name = document.getElementById('cc-name').value.trim();",
" var type = document.getElementById('cc-type').value;",
" var genre = document.getElementById('cc-genre').value;",
" var sort = document.getElementById('cc-sort').value;",
" if (!name) { var n = document.getElementById('cc-name'); n.classList.add('error'); set
" var tmdbType = type === 'series' ? 'tv' : 'movie';",
" var params = { sort_by: sort };",
" if (genre) params.with_genres = genre;",
" state.customCatalogs.push({ id: 'custom.' + Date.now(), name: name, type: type, path:
" document.getElementById('cc-name').value = ''; document.getElementById('cc-genre').val
" document.getElementById('custom-catalog-form').classList.remove('open');",
" renderCustomCatalogsList();",
"}",
"function removeCustomCatalog(id) { state.customCatalogs = state.customCatalogs.filter(fu
"function renderCustomCatalogsList() {",
" var el = document.getElementById('custom-catalogs-list');",
" if (!state.customCatalogs.length) { el.innerHTML = '<div class=\"custom-seasons-empty\
" var sortLabels = { 'popularity.desc': 'Popular', 'vote_average.desc': 'Top Rated', 're
" el.innerHTML = state.customCatalogs.map(function(c) {",
" var sortLabel = (c.params && sortLabels[c.params.sort_by]) || '';",
" var genrePart = c.params && c.params.with_genres ? ' \u00b7 Genre ' + c.params.with_
" return '<div class=\"custom-catalog-item\"><div class=\"custom-catalog-item-info\"><
" }).join('');",
"}",
"",
// ── Show search ─────────────────────────────────────────────────────────
"var searchTimer;",
"function debounceSearch(q) {",
" clearTimeout(searchTimer);",
" if (!q.trim()) { document.getElementById('search-results').classList.remove('visible')
" searchTimer = setTimeout(function() { doSearch(q); }, 350);",
"}",
"async function doSearch(q) {",
" var box = document.getElementById('search-results');",
" box.classList.add('visible');",
" box.innerHTML = '<div class=\"loading-overlay\"><div class=\"spinner\"></div> Searchin
" try {",
" var r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&apiKey=' + encodeUR
" var d = await r.json();",
" if (!d.results || !d.results.length) { box.innerHTML = '<p style=\"padding:1rem;font
" box.innerHTML = d.results.map(function(s) {",
" var ph = s.poster ? '<img class=\"search-poster\" src=\"' + s.poster + '\" alt=\"\
" return '<div class=\"search-result-item\" onclick=\"createNewList(' + s.id + ',\\'
" }).join('');",
" } catch(e) { box.innerHTML = '<p style=\"padding:1rem;color:var(--text-mute)\">Error s
"}",
"",
// ── Create / manage lists ────────────────────────────────────────────────
"function createNewList(tmdbId, name, poster) {",
" var listId = uid();",
" state.customSeasons.push({ listId: listId, tmdbId: String(tmdbId), tmdbName: name, tmd
" document.getElementById('search-results').classList.remove('visible');",
" document.getElementById('series-search').value = '';",
" renderCustomSeasonsList();",
" setTimeout(function() {",
" var card = document.getElementById('card-' + listId);",
" if (card) card.classList.add('open');",
" openModal(listId);",
" }, 50);",
"}",
"",
"function getList(listId) { return state.customSeasons.find(function(l) { return l.listId
"",
"function updateListMeta(listId, field, value) {",
" var list = getList(listId);",
" if (list) { list[field] = value; }",
" var nameEl = document.getElementById('list-name-' + listId);",
" if (nameEl && list) nameEl.textContent = (list.prefix || '\u2b50') + ' ' + (list.label
"}",
"",
"function removeList(listId) {",
" state.customSeasons = state.customSeasons.filter(function(l) { return l.listId !== lis
" renderCustomSeasonsList();",
"}",
"function removeEp(listId, idx) {",
" var list = getList(listId);",
" if (!list) return;",
" list.episodes.splice(idx, 1);",
" renderCustomSeasonsList();",
"}",
"function toggleCard(listId) { document.getElementById('card-' + listId).classList.toggle
"",
// ── Episode picker modal ─────────────────────────────────────────────────
"async function openModal(listId) {",
" var list = getList(listId);",
" if (!list) return;",
" modalData.listId = listId;",
" modalData.tmdbId = list.tmdbId;",
" modalData.tmdbName = list.tmdbName;",
" modalData.tmdbPoster = list.tmdbPoster;",
" modalData.allEpisodes = []; modalData.filteredSeason = 'all';",
" modalData.selected = new Set(list.episodes.map(function(e) { return e.season + ':' + e
" document.getElementById('modal-show-name').textContent = list.tmdbName;",
" document.getElementById('modal-show-sub').textContent = 'Loading...';",
" document.getElementById('modal-poster').src = list.tmdbPoster || '';",
" document.getElementById('modal-season-filters').innerHTML = '';",
" document.getElementById('modal-ep-list').innerHTML = '<div class=\"loading-overlay\"><
" updateModalCount();",
" document.getElementById('modal-backdrop').classList.add('open');",
" document.body.style.overflow = 'hidden';",
" try {",
" var r = await fetch('/api/episodes?tmdbId=' + list.tmdbId + '&apiKey=' + encodeURICo
" var d = await r.json();",
" if (d.error) throw new Error(d.error);",
" modalData.allEpisodes = d.episodes;",
" document.getElementById('modal-show-sub').textContent = d.show.seasons + ' season' +
" var seasons = []; d.episodes.forEach(function(e) { if (seasons.indexOf(e.season) ===
" var filters = document.getElementById('modal-season-filters');",
" var btns = ['<button class=\"season-filter-btn active\" onclick=\"setSeasonFilter(\\
" seasons.forEach(function(s) { btns.push('<button class=\"season-filter-btn\" onclick
" filters.innerHTML = btns.join('');",
" renderModalEpisodes();",
" } catch(e) {",
" document.getElementById('modal-ep-list').innerHTML = '<p style=\"padding:1rem;color:
" }",
"}",
"function setSeasonFilter(val, btn) {",
" modalData.filteredSeason = val;",
" document.querySelectorAll('.season-filter-btn').forEach(function(b) { b.classList.remo
" btn.classList.add('active');",
" renderModalEpisodes();",
"}",
"function renderModalEpisodes() {",
" var eps = modalData.filteredSeason === 'all' ? modalData.allEpisodes : modalData.allEp
" var list = document.getElementById('modal-ep-list');",
" if (!eps.length) { list.innerHTML = '<p style=\"padding:1rem;color:var(--text-mute)\">
" list.innerHTML = eps.map(function(ep) {",
" var key = ep.season + ':' + ep.episode;",
" var sel = modalData.selected.has(key);",
" var sL = String(ep.season).padStart(2,'0'); var eL = String(ep.episode).padStart(2,'
" var th = ep.still ? '<img class=\"modal-ep-thumb\" src=\"' + ep.still + '\" alt=\"\"
" return '<div class=\"modal-ep-item' + (sel ? ' selected' : '') + '\" onclick=\"toggl
" }).join('');",
"}",
"function toggleEp(key, el) {",
" if (modalData.selected.has(key)) { modalData.selected.delete(key); el.classList.remove
" else { modalData.selected.add(key); el.classList.add('selected'); el.querySelector('.m
" updateModalCount();",
"}",
ep.epi
"function updateModalCount() { document.getElementById('modal-sel-count').textContent = m
"function addSelectedEpisodes() {",
" var list = getList(modalData.listId);",
" if (!list) { closeModal(); return; }",
" var keys = Array.from(modalData.selected);",
" var episodes = keys.map(function(k) {",
" var p = k.split(':').map(Number);",
" return modalData.allEpisodes.find(function(ep) { return ep.season === p[0] && " }).filter(Boolean);",
" var existingKeys = new Set(list.episodes.map(function(e) { return e.season + ':' + e.e
" var kept = list.episodes.filter(function(e) { return keys.indexOf(e.season + ':' + e.e
" var newEps = episodes.filter(function(e) { return !existingKeys.has(e.season + ':' + e
" list.episodes = kept.concat(newEps);",
" closeModal();",
" renderCustomSeasonsList();",
"}",
"function closeModal() { document.getElementById('modal-backdrop').classList.remove('open
"function closeModalOnBackdrop(e) { if (e.target === document.getElementById('modal-backd
"",
// ── IMDB import ─────────────────────────────────────────────────────────
"async function importImdbList(listId) {",
" var list = getList(listId);",
" if (!list) return;",
" var input = document.getElementById('imdb-url-' + listId);",
" var status = document.getElementById('imdb-status-' + listId);",
" var btn = document.getElementById('imdb-btn-' + listId);",
" var url = (input ? input.value : '').trim();",
" if (!url) { if (status) { status.textContent = 'Please enter an IMDB list URL'; status
" if (btn) { btn.disabled = true; btn.innerHTML = '<span class=\"spinner\"></span>'; }",
" if (status) { status.textContent = 'Fetching list\u2026'; status.className = 'imdb-imp
" try {",
" var r = await fetch('/api/imdb-list?url=' + encodeURIComponent(url) + '&apiKey=' + e
" var d = await r.json();",
" if (d.error) throw new Error(d.error);",
" if (!d.episodes || !d.episodes.length) throw new Error('No matching episodes found f
" var existingKeys = new Set(list.episodes.map(function(e) { return e.season + ':' + e
" var allEpsForShow = modalData.tmdbId === list.tmdbId ? modalData.allEpisodes : [];",
" var added = 0;",
" for (var i = 0; i < d.episodes.length; i++) {",
" var ref = d.episodes[i];",
" var key = ref.season + ':' + ref.episode;",
" if (!existingKeys.has(key)) {",
" existingKeys.add(key);",
" var full = allEpsForShow.find(function(e) { return e.season === ref.season && e.
" list.episodes.push(full || ref);",
" added++;",
" }",
if (ca
+ ' \u
" }",
" var msg = 'Added ' + added + ' episode' + (added !== 1 ? 's' : '');",
" if (d.skipped) msg += ' (' + d.skipped + ' skipped/not found)';",
" if (status) { status.textContent = msg; status.className = 'imdb-import-status ok';
" if (input) input.value = '';",
" renderCustomSeasonsList();",
" setTimeout(function() { var card = document.getElementById('card-' + listId); " } catch(e) {",
" if (status) { status.textContent = 'Error: ' + e.message; status.className = 'imdb-i
" } finally {",
" if (btn) { btn.disabled = false; btn.textContent = 'Import'; }",
" }",
"}",
"",
// ── Render lists ─────────────────────────────────────────────────────────
"function renderCustomSeasonsList() {",
" var el = document.getElementById('custom-seasons-list');",
" var cnt = document.getElementById('custom-count');",
" cnt.textContent = state.customSeasons.length ? state.customSeasons.length + ' list' +
" if (!state.customSeasons.length) { el.innerHTML = '<div class=\"custom-seasons-empty\"
" el.innerHTML = state.customSeasons.map(function(list) {",
" var tid = list.listId;",
" var ph = list.tmdbPoster ? '<img class=\"list-poster\" src=\"' + list.tmdbPoster + '
" var displayName = (list.prefix || '\u2b50') + ' ' + (list.label || 'Best Of') " var epItems = list.episodes.map(function(ep, i) {",
" var sL = String(ep.season).padStart(2,'0'); var eL = String(ep.episode).padStart(2
" var th = ep.still ? '<img class=\"ep-thumb\" src=\"' + ep.still + '\" alt=\"\" loa
" return '<li class=\"ep-item\" draggable=\"true\" data-lid=\"' + tid + '\" data-idx
" '<span class=\"ep-rank\">' + (i+1) + '</span><span class=\"ep-drag\">&#8943;</sp
" '<div class=\"ep-info\"><div class=\"ep-label\">S' + sL + 'E' + eL + ' \u2014 '
" (ep.vote_average > 0 ? '<span class=\"ep-rating\">&#11088;' + ep.vote_average.to
" '<span class=\"ep-del\" onclick=\"removeEp(\\'' + tid + '\\',' + i + ')\" title=
" }).join('');",
" return '<div class=\"list-card\" id=\"card-' + tid + '\">' +",
" '<div class=\"list-card-header\" onclick=\"toggleCard(\\'' + tid + '\\')\">'+ph+",
" '<div class=\"list-card-meta\"><div class=\"list-card-name\" id=\"list-name-' + ti
" '<span class=\"list-card-count\">' + list.episodes.length + ' ep' + (list.episodes
" '<span class=\"list-card-chevron\">&rsaquo;</span></div>' +",
" '<div class=\"list-card-body\">' +",
// Prefix + label editors
" '<div class=\"list-meta-row\">' +",
" '<div class=\"field prefix-field\"><label>Prefix</label><input type=\"text\" v
" '<div class=\"field\"><label>List Label</label><input type=\"text\" value=\"'
" '</div>' +",
// Episode add tabs: Pick, IMDB, Paste
" '<div class=\"ep-add-section\">' +",
" '<div class=\"ep-add-tabs\">' +",
'\" on
+ tid
" '<button class=\"ep-add-tab active\" id=\"ep-tab-picker-' + tid + '\" onclic
" '<button class=\"ep-add-tab\" id=\"ep-tab-imdb-' + tid + '\" onclick=\"switc
" '<button class=\"ep-add-tab\" id=\"ep-tab-paste-' + tid + '\" onclick=\"swit
" '<button class=\"ep-add-tab\" id=\"ep-tab-ai-' + tid + '\" onclick=\"switchE
" '</div>' +",
// Picker panel
" '<div class=\"ep-add-panel active\" id=\"ep-panel-picker-' + tid + '\">' +",
" '<button class=\"btn btn-secondary btn-sm\" style=\"width:100%;margin-top:2p
" '</div>' +",
// IMDB panel
" '<div class=\"ep-add-panel\" id=\"ep-panel-imdb-' + tid + '\">' +",
" '<div class=\"imdb-import-row\">' +",
" '<input type=\"text\" id=\"imdb-url-' + tid + '\" placeholder=\"https://ww
" '<button class=\"btn btn-secondary btn-sm\" id=\"imdb-btn-' + tid + " '</div>' +",
" '<div class=\"imdb-import-status\" id=\"imdb-status-' + tid + '\"></div>' +"
" '</div>' +",
// Paste panel
" '<div class=\"ep-add-panel\" id=\"ep-panel-paste-' + tid + '\">' +",
" '<p class=\"paste-hint\">Paste a list of episode codes, one per line or spac
" '<textarea id=\"paste-input-' + tid + '\" placeholder=\"S01E01&#10;S01E05&#1
" '<div class=\"paste-actions\">' +",
" '<button class=\"btn btn-primary btn-sm\" onclick=\"applyPaste(\\'' " '<span class=\"paste-status\" id=\"paste-status-' + tid + '\"></span>' +",
" '</div>' +",
" '</div>' +",
// AI panel
" '<div class=\"ep-add-panel\" id=\"ep-panel-ai-' + tid + '\">' +",
" '<div class=\"ai-panel-inner\">' +",
" '<div class=\"ai-row\">' +",
" '<div class=\"field\"><label>What to focus on</label><input type=\"text\
" '<div class=\"field ai-count-field\"><label>Count</label><input type=\"n
" '</div>' +",
" '<div class=\"ai-actions\">' +",
" '<button class=\"btn btn-primary btn-sm\" id=\"ai-gen-btn-' + tid " '<button class=\"btn btn-secondary btn-sm\" id=\"ai-copy-btn-' + tid + '
" '</div>' +",
" '<div class=\"ai-status\" id=\"ai-status-' + tid + '\"></div>' +",
" '<div class=\"ai-raw-out\" id=\"ai-raw-' + tid + '\"></div>' +",
" '</div>' +",
" '</div>' +",
" '</div>' +",
// Episode list
" '<ul class=\"ep-list\" id=\"eplist-' + tid + '\" data-lid=\"' + tid + '\" style=
" '<div class=\"ep-list-actions\"><button class=\"btn btn-danger btn-sm\" onclick=
" '</div>' +",
" '</div>';",
+ '\"
" }).join('');",
" state.customSeasons.forEach(function(list) { initDragSort(list.listId); });",
"}",
"",
// ── Drag sort ────────────────────────────────────────────────────────────
"function initDragSort(listId) {",
" var listEl = document.getElementById('eplist-' + listId);",
" if (!listEl) return;",
" var dragIdx = null;",
" listEl.querySelectorAll('.ep-item').forEach(function(item, idx) {",
" item.addEventListener('dragstart', function(e) { dragIdx = idx; item.classList.add('
" item.addEventListener('dragend', function() { item.classList.remove('dragging');
" item.addEventListener('dragover', function(e) { e.preventDefault(); listEl.querySel
" item.addEventListener('dragleave', function() { item.classList.remove('drag-over');
" item.addEventListener('drop', function(e) {",
" e.preventDefault(); item.classList.remove('drag-over');",
" var dropIdx = parseInt(item.dataset.idx);",
" if (dragIdx === null || dragIdx === dropIdx) return;",
" var list = getList(listId);",
" if (!list) return;",
" var moved = list.episodes.splice(dragIdx, 1)[0];",
" list.episodes.splice(dropIdx, 0, moved);",
" renderCustomSeasonsList();",
" var card = document.getElementById('card-' + listId);",
" if (card) card.classList.add('open');",
" });",
" });",
"}",
"",
// ── Install page ─────────────────────────────────────────────────────────
"function buildInstallPage() {",
" var flat = state.customSeasons.map(function(list) {",
" return {",
" listId: list.listId,",
" tmdbId: list.tmdbId,",
" label: list.label || 'Best Of',",
" prefix: list.prefix || '\u2b50',",
" episodes: list.episodes.map(function(e) { return { season: e.season, episode: e.ep
" };",
" });",
" var cfg = { tmdbApiKey: state.apiKey, topN: state.topN, showAutoSeason: state.showAuto
" var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));",
" var manifestUrl = window.location.origin + '/' + encoded + '/manifest.json';",
" document.getElementById('manifest-url').value = manifestUrl;",
" var listCount = state.customSeasons.length;",
" var showCount = new Set(state.customSeasons.map(function(l) { return l.tmdbId; })).siz
" var enabledDefaultCount = DEFAULT_CATALOGS.filter(function(d) { var ov = state.catalog
if (!u
" var customCatCount = state.customCatalogs.length;",
" document.getElementById('install-summary').innerHTML =",
" '<div class=\"summary-row\"><span class=\"summary-label\">Default catalogs enabled</
" '<div class=\"summary-row\"><span class=\"summary-label\">Custom catalogs</span><spa
" '<div class=\"summary-row\"><span class=\"summary-label\">Auto Best Of (Season 0)</s
" '<div class=\"summary-row\" style=\"margin-bottom:1.4rem\"><span class=\"summary-lab
"}",
"",
"function openStremio() { var url = document.getElementById('manifest-url').value; "function copyUrl() {",
" var input = document.getElementById('manifest-url');",
" input.select();",
" try { document.execCommand('copy'); } catch(e) { navigator.clipboard && navigator.clip
" var btn = document.getElementById('copy-btn');",
" btn.textContent = 'Copied!'; btn.classList.add('copied');",
" setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2
"}",
"",
"function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').repl
"function esc4attr(s) { return String(s || '').replace(/'/g, '&#39;'); }",
].join('\n');
// ── HTML ───────────────────────────────────────────────────────────────────
return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
'<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=
'<title>TMDB Best Of - Configure</title>\n' +
'<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
'<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family
'<style>\n' + css + '\n</style>\n</head>\n<body>\n' +
'<div class="app">\n' +
// ── Topbar: now 5 steps ──
' <div class="topbar">\n' +
' <div class="topbar-logo">&#127916; TMDB Best Of</div>\n' +
' <div class="topbar-steps">\n' +
' <div class="step-item active" id="step-tab-1"><span class="step-num">1</span><span
' <div class="step-item" id="step-tab-2"><span class="step-num">2</span><span ' <div class="step-item" id="step-tab-3"><span class="step-num">3</span><span ' <div class="step-item" id="step-tab-4"><span class="step-num">4</span><span ' <div class="step-item" id="step-tab-5"><span class="step-num">5</span><span ' </div>\n </div>\n' +
' <div class="main">\n' +
class=
class=
class=
class=
// ── PAGE 1: API Key ──
' <div class="page active" id="page-1"><div class="card">\n' +
' <div style="text-align:center;padding:1rem 0 1.8rem;font-size:4rem;opacity:0.6">&#
' <div class="card-title">Connect to TMDB</div>\n' +
' <div class="card-sub">Enter your free TMDB API key to get started.</div>\n' +
' <div class="features-grid">\n' +
' <div class="feature-chip">&#127916; Movie metadata</div><div class="feature-chip
' <div class="feature-chip">&#128269; TMDB search</div><div class="feature-chip">&
' <div class="feature-chip">&#11088; Auto Best Of season</div><div class="feature-
' </div>\n' +
' <div class="field"><label>TMDB API Key (v3) <span style="color:var(--danger)">*</s
' <div class="field" style="border-top:1px solid var(--border);padding-top:1.1rem;ma
' <label>Gemini API Key <span style="background:rgba(139,92,246,0.15);color:var(--
' <input type="password" id="geminiKey" placeholder="Optional — enables Gemini AI
' <p class="hint">For the &#10024; AI tab when building lists. Without a key, a fr
' </div>\n' +
' <button class="btn btn-primary btn-lg" style="width:100%" onclick="validateApiKey(
' </div></div>\n' +
// ── PAGE 2: Best Of Settings (own screen, beta) ──
' <div class="page" id="page-2">\n' +
' <div class="bestof-auto-card">\n' +
' <div class="bestof-auto-title">&#11088; Auto Best Of <span class="beta-badge">Be
' <div class="bestof-auto-desc">Adds a hidden <strong>Season 0</strong> inside eve
' <div class="bestof-auto-row">\n' +
' <div class="field"><label>Top N episodes</label><input type="number" id="topN"
' <div style="padding-bottom:1.25rem">\n' +
' <div class="catalog-row" style="min-width:200px">\n' +
' <div class="catalog-row-info"><div class="catalog-row-name">Enable Season
' <label class="toggle"><input type="checkbox" id="showAutoSeason" checked/>
' </div>\n' +
' </div>\n' +
' </div>\n' +
' </div>\n' +
' <div class="nav-row"><button class="btn btn-secondary" onclick="goTo(1)">&larr; Ba
' </div>\n' +
// ── PAGE 3: Catalogs ──
' <div class="page" id="page-3">\n' +
' <div class="card"><div class="card-title">&#128198; TMDB Catalogs</div><div class=
' <div class="catalog-section-label">&#127916; Movies</div><div id="catalog-defaul
' <div class="catalog-section-label">&#128250; Series</div><div id="catalog-defaul
' </div>\n' +
' <div class="card"><div class="section-header"><div><div class="card-title">&#10133
' <div class="custom-catalog-form" id="custom-catalog-form">\n' +
' <div class="form-row"><div class="field" style="margin-bottom:0"><label>Catalo
' <div class="form-row" style="margin-top:10px"><div class="field" style="margin
' <div style="display:flex;gap:8px;margin-top:14px"><button class="btn btn-prima
' </div>\n' +
' <div id="custom-catalogs-list" style="margin-top:14px"><div class="custom-season
' </div>\n' +
' <div class="nav-row"><button class="btn btn-secondary" onclick="goTo(2)">&larr; Ba
' </div>\n' +
// ── PAGE 4: Best Of Lists ──
' <div class="page" id="page-4">\n' +
' <div class="card">\n' +
' <div class="card-title">&#11088; Custom Best Of Lists</div>\n' +
' <div class="card-sub">Search for a show to create a named list. Each list become
' <div class="search-wrap field"><span class="search-icon">&#128269;</span><input
' <div id="search-results" class="search-results"></div>\n' +
' </div>\n' +
' <div class="card"><div class="section-header"><span class="section-title">Your Bes
' <div id="custom-seasons-list"><div class="custom-seasons-empty">No lists yet. Se
' </div>\n' +
' <div class="nav-row"><button class="btn btn-secondary" onclick="goTo(3)">&larr; Ba
' </div>\n' +
// ── PAGE 5: Install ──
' <div class="page" id="page-5"><div class="card">\n' +
' <div class="generate-hero"><div style="font-size:3.5rem;margin-bottom:12px">&#1286
' <div id="install-summary"></div>\n' +
' <button class="btn btn-install" onclick="openStremio()">&#9889; Install in Stremio
' <div class="or-line">-- or add manually --</div>\n' +
' <div class="copy-row"><input type="text" id="manifest-url" readonly/><button class
' </div><div class="nav-row"><button class="btn btn-secondary" onclick="goTo(4)">&larr
' </div>\n</div>\n' +
// ── Modal ──
'<div class="modal-backdrop" id="modal-backdrop" onclick="closeModalOnBackdrop(event)">\n
' <div class="modal">\n' +
' <div class="modal-header"><img class="modal-poster" id="modal-poster" src="" alt=""/
' <div class="modal-filter" id="modal-season-filters"></div>\n' +
' <div class="modal-ep-list" id="modal-ep-list"><div class="loading-overlay"><div clas
' <div class="modal-footer"><span class="modal-selected-count">Selected: <span id="mod
' </div>\n</div>\n' +
'<script>\n' +
// syncAutoSettings reads page 2 inputs into state before leaving
'function syncAutoSettings() {' +
' state.topN = parseInt(document.getElementById("topN").value) || 20;' +
' state.showAutoSeason = document.getElementById("showAutoSeason").checked;' +
'}' +
'\n' + clientJS + '\n</script>\n</body>\n</html>';
}
const PORT = process.env.PORT || 7000;
app.listen(PORT, function() {
console.log('TMDB Best Of addon running on port ' + PORT);
console.log('Configure: http://localhost:' + PORT + '/configure');
});