const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ─── CORS (required for Stremio) ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// ─── Constants ────────────────────────────────────────────────────────────────
const TMDB_IMG_SM = 'https://image.tmdb.org/t/p/w300';
const TMDB_IMG_MD = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMG_LG = 'https://image.tmdb.org/t/p/w1280';
const TMDB_BASE   = 'https://api.themoviedb.org/3';

// ─── Config helpers ───────────────────────────────────────────────────────────
function parseConfig(str) {
  try { return JSON.parse(Buffer.from(str, 'base64').toString('utf8')); }
  catch { return {}; }
}

// ─── TMDB fetch wrapper ───────────────────────────────────────────────────────
async function tmdb(path, apiKey, params = {}) {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const { data } = await axios.get(url.toString());
  return data;
}

// ─── TMDB helpers ─────────────────────────────────────────────────────────────
function extractId(id) { return id.replace(/^tmdb:/, ''); }

async function getMovie(tmdbId, apiKey) {
  return tmdb(`/movie/${tmdbId}`, apiKey, {
    append_to_response: 'external_ids,release_dates,credits,videos',
  });
}

async function getSeries(tmdbId, apiKey) {
  return tmdb(`/tv/${tmdbId}`, apiKey, {
    append_to_response: 'external_ids,content_ratings,credits',
  });
}

async function getSeason(tmdbId, seasonNum, apiKey) {
  return tmdb(`/tv/${tmdbId}/season/${seasonNum}`, apiKey);
}

async function getAllEpisodes(tmdbId, apiKey, totalSeasons) {
  const episodes = [];
  for (let s = 1; s <= totalSeasons; s++) {
    try {
      const season = await getSeason(tmdbId, s, apiKey);
      for (const ep of (season.episodes || [])) {
        episodes.push({
          season:       s,
          episode:      ep.episode_number,
          name:         ep.name,
          overview:     ep.overview || '',
          still:        ep.still_path ? `${TMDB_IMG_SM}${ep.still_path}` : null,
          vote_average: ep.vote_average || 0,
          vote_count:   ep.vote_count   || 0,
          air_date:     ep.air_date,
        });
      }
    } catch { /* skip broken seasons */ }
  }
  return episodes;
}

async function getTopEpisodes(tmdbId, apiKey, totalSeasons, topN = 20) {
  const all = await getAllEpisodes(tmdbId, apiKey, totalSeasons);
  const filtered = all.filter(e => e.vote_count >= 5);
  filtered.sort((a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count);
  return filtered.slice(0, topN);
}

// Extract US content rating for series
function getSeriesCert(data) {
  try {
    const us = (data.content_ratings?.results || []).find(r => r.iso_3166_1 === 'US');
    return us?.rating || null;
  } catch { return null; }
}

// Extract US theatrical cert for movies
function getMovieCert(data) {
  try {
    const us = (data.release_dates?.results || []).find(r => r.iso_3166_1 === 'US');
    const rel = (us?.release_dates || []).find(d => d.type === 3 || d.type === 4);
    return rel?.certification || null;
  } catch { return null; }
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
app.get('/manifest.json',         (req, res) => res.json(buildManifest()));
app.get('/:config/manifest.json', (req, res) => res.json(buildManifest(req.params.config)));

function buildManifest(config) {
  const cfg = config ? parseConfig(config) : {};
  return {
    id:          'community.tmdb-metadata-bestof',
    version:     '2.0.0',
    name:        'TMDB Metadata + Best Of',
    description: 'Full TMDB metadata for movies & series. Injects a "⭐ Best Of" season into every show with top-rated episodes.',
    logo:        'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg',
    catalogs:    [],
    resources:   ['meta', 'episodeVideos'],
    types:       ['movie', 'series'],
    idPrefixes:  ['tmdb:'],
    behaviorHints: {
      configurable:           true,
      configurationRequired:  !cfg.tmdbApiKey,
    },
    config: [
      { key: 'tmdbApiKey', type: 'text',   title: 'TMDB API Key',                                required: true  },
      { key: 'topN',       type: 'number', title: 'Top episodes in Best Of season (default: 20)', required: false },
    ],
  };
}

// ─── Configure page ───────────────────────────────────────────────────────────
app.get('/',          (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => res.send(configurePage()));

// ─── Movie meta ───────────────────────────────────────────────────────────────
app.get('/:config/meta/movie/:id.json', async (req, res) => {
  const { config, id } = req.params;
  const cfg = parseConfig(config);
  if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });
  if (!id.startsWith('tmdb:')) return res.json({ meta: null });

  try {
    const movie    = await getMovie(extractId(id), cfg.tmdbApiKey);
    const cert     = getMovieCert(movie);
    const director = movie.credits?.crew?.find(c => c.job === 'Director');
    const cast     = (movie.credits?.cast || []).slice(0, 8).map(c => c.name);

    // Pick a YouTube trailer if available
    const trailerKey = movie.videos?.results?.find(
      v => v.type === 'Trailer' && v.site === 'YouTube'
    )?.key;

    const meta = {
      id,
      type:        'movie',
      name:        movie.title,
      poster:      movie.poster_path   ? `${TMDB_IMG_MD}${movie.poster_path}`   : null,
      background:  movie.backdrop_path ? `${TMDB_IMG_LG}${movie.backdrop_path}` : null,
      description: movie.overview,
      releaseInfo: movie.release_date ? movie.release_date.substring(0, 4) : '',
      runtime:     movie.runtime      ? `${movie.runtime} min`              : null,
      genres:      (movie.genres || []).map(g => g.name),
      imdbRating:  movie.vote_average  ? movie.vote_average.toFixed(1)      : null,
      cast,
      director:       director?.name  || null,
      certification:  cert            || null,
      trailers:       trailerKey ? [{ source: 'yt', type: 'Trailer', ytId: trailerKey }] : [],
      links:          movie.external_ids?.imdb_id
        ? [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${movie.external_ids.imdb_id}` }]
        : [],
    };

    res.json({ meta });
  } catch (e) {
    console.error('[movie meta]', e.message);
    res.status(500).json({ err: e.message });
  }
});

// ─── Series meta + Best Of injection ─────────────────────────────────────────
app.get('/:config/meta/series/:id.json', async (req, res) => {
  const { config, id } = req.params;
  const cfg = parseConfig(config);
  if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });
  if (!id.startsWith('tmdb:')) return res.json({ meta: null });

  const tmdbId = extractId(id);
  const topN   = parseInt(cfg.topN) || 20;

  try {
    const series = await getSeries(tmdbId, cfg.tmdbApiKey);
    const cert   = getSeriesCert(series);
    const cast   = (series.credits?.cast || []).slice(0, 8).map(c => c.name);
    const videos = [];

    // ── Real seasons ──────────────────────────────────────────────────────
    for (let s = 1; s <= (series.number_of_seasons || 0); s++) {
      try {
        const season = await getSeason(tmdbId, s, cfg.tmdbApiKey);
        for (const ep of (season.episodes || [])) {
          videos.push({
            id:        `${id}:${s}:${ep.episode_number}`,
            title:     ep.name || `Episode ${ep.episode_number}`,
            season:    s,
            episode:   ep.episode_number,
            overview:  ep.overview || '',
            thumbnail: ep.still_path ? `${TMDB_IMG_SM}${ep.still_path}` : null,
            released:  ep.air_date  ? new Date(ep.air_date)              : null,
            rating:    ep.vote_average ? ep.vote_average.toFixed(1)      : null,
          });
        }
      } catch { /* skip */ }
    }

    // ── Virtual Season 0 — Best Of ────────────────────────────────────────
    const topEps = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN);
    topEps.forEach((ep, i) => {
      const rank = i + 1;
      const sLabel = String(ep.season).padStart(2, '0');
      const eLabel = String(ep.episode).padStart(2, '0');
      videos.push({
        id:        `${id}:0:${rank}`,
        title:     `#${rank} — S${sLabel}E${eLabel} — ${ep.name}`,
        season:    0,
        episode:   rank,
        overview:  `⭐ ${ep.vote_average.toFixed(1)}/10  (${ep.vote_count.toLocaleString()} votes)\n\n${ep.overview || ''}`,
        thumbnail: ep.still || null,
        released:  ep.air_date ? new Date(ep.air_date) : null,
      });
    });

    // Compute year range for display
    const startYear = series.first_air_date?.substring(0, 4) || '';
    const endYear   = series.last_air_date?.substring(0, 4)  || '';
    const releaseInfo = series.status === 'Ended' && endYear
      ? `${startYear}–${endYear}`
      : startYear;

    const meta = {
      id,
      type:          'series',
      name:          series.name,
      poster:        series.poster_path   ? `${TMDB_IMG_MD}${series.poster_path}`   : null,
      background:    series.backdrop_path ? `${TMDB_IMG_LG}${series.backdrop_path}` : null,
      description:   series.overview,
      releaseInfo,
      runtime:       series.episode_run_time?.[0] ? `${series.episode_run_time[0]} min` : null,
      genres:        (series.genres || []).map(g => g.name),
      imdbRating:    series.vote_average  ? series.vote_average.toFixed(1) : null,
      cast,
      certification: cert || null,
      videos,
      links:         series.external_ids?.imdb_id
        ? [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${series.external_ids.imdb_id}` }]
        : [],
    };

    res.json({ meta });
  } catch (e) {
    console.error('[series meta]', e.message);
    res.status(500).json({ err: e.message });
  }
});

// ─── episodeVideos — resolve Best Of virtual ep → real ep ID ─────────────────
app.get('/:config/episodeVideos/series/:id.json', async (req, res) => {
  const { config, id } = req.params;
  const cfg = parseConfig(config);
  if (!cfg.tmdbApiKey) return res.json({ videos: [] });

  // id arrives as  tmdb:12345:0:3  when Stremio resolves a specific episode
  const parts = id.split(':');
  if (parts.length < 4 || parts[0] !== 'tmdb') return res.json({ videos: [] });

  const [, tmdbId, seasonStr, epStr] = parts;
  const season     = parseInt(seasonStr);
  const episodeNum = parseInt(epStr);
  const topN       = parseInt(cfg.topN) || 20;

  // Only intercept our virtual Season 0
  if (season !== 0) return res.json({ videos: [] });

  try {
    const series  = await getSeries(tmdbId, cfg.tmdbApiKey);
    const topEps  = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN);
    const target  = topEps[episodeNum - 1];
    if (!target) return res.json({ videos: [] });

    // Hand back the real episode ID so streaming addons can locate streams
    res.json({
      videos: [{
        id:        `tmdb:${tmdbId}:${target.season}:${target.episode}`,
        title:     target.name,
        season:    target.season,
        episode:   target.episode,
        thumbnail: target.still,
        overview:  target.overview,
      }],
    });
  } catch (e) {
    console.error('[episodeVideos]', e.message);
    res.json({ videos: [] });
  }
});

// ─── Configure page HTML ──────────────────────────────────────────────────────
function configurePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>TMDB Metadata + Best Of — Configure</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0c0c12;
      color: #dde1ea;
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 2rem 1rem;
    }
    .card {
      background: #16161f;
      border: 1px solid #252535;
      border-radius: 20px;
      padding: 2.8rem 2.4rem 2.4rem;
      max-width: 500px; width: 100%;
      box-shadow: 0 12px 60px rgba(0,0,0,0.6);
    }
    .header { display: flex; align-items: center; gap: 14px; margin-bottom: 2rem; }
    .icon {
      flex-shrink: 0; width: 50px; height: 50px;
      background: linear-gradient(135deg, #01b4e4, #0d6efd);
      border-radius: 13px;
      display: flex; align-items: center; justify-content: center;
      font-size: 26px;
    }
    h1 { font-size: 1.3rem; font-weight: 700; color: #fff; line-height: 1.2; }
    .subtitle { font-size: 0.78rem; color: #555; margin-top: 3px; }
    .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 2rem; }
    .pill {
      font-size: 0.7rem; font-weight: 600;
      padding: 4px 11px; border-radius: 20px;
      background: #1e1e2d; border: 1px solid #2e2e45; color: #888;
    }
    .pill.blue  { border-color: #01b4e4; color: #01b4e4; }
    .pill.green { border-color: #90cea1; color: #90cea1; }
    .pill.gold  { border-color: #f5c518; color: #f5c518; }
    .section-label {
      font-size: 0.68rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.1em; color: #444;
      margin-bottom: 1rem;
      display: flex; align-items: center; gap: 10px;
    }
    .section-label::after { content:''; flex:1; height:1px; background:#252535; }
    .field { margin-bottom: 1.5rem; }
    label { display:block; font-size:0.82rem; color:#bbb; margin-bottom:6px; font-weight:500; }
    input[type=text], input[type=number] {
      width: 100%;
      background: #0c0c12; border: 1.5px solid #252535;
      border-radius: 10px; padding: 11px 14px;
      color: #e8ecf0; font-size: 0.93rem;
      outline: none; transition: border-color 0.18s;
    }
    input:focus { border-color: #01b4e4; }
    input.error { border-color: #e74c3c !important; }
    .hint { font-size: 0.72rem; color: #555; margin-top: 5px; }
    .hint a { color: #01b4e4; text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
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
    .or-line { text-align:center; font-size:0.72rem; color:#444; margin: 12px 0 10px; }
    .copy-row { display: flex; gap: 8px; }
    .copy-row input { flex:1; font-size:0.73rem; color:#555; padding:9px 12px; }
    .btn-copy {
      flex-shrink:0; padding:9px 16px;
      background:#1e1e2d; border:1.5px solid #2e2e45; border-radius:10px;
      color:#aaa; font-size:0.78rem; font-weight:600;
      cursor:pointer; transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .btn-copy:hover { background:#252535; color:#fff; }
    .btn-copy.copied { border-color:#90cea1; color:#90cea1; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="icon">🎬</div>
      <div>
        <h1>TMDB Metadata + Best Of</h1>
        <p class="subtitle">Stremio Addon &nbsp;·&nbsp; v2.0</p>
      </div>
    </div>

    <div class="pills">
      <span class="pill blue">🎬 Movies</span>
      <span class="pill blue">📺 Series</span>
      <span class="pill green">📋 Full Metadata</span>
      <span class="pill gold">⭐ Best Of Season</span>
    </div>

    <div class="section-label">Required</div>

    <div class="field">
      <label for="apiKey">TMDB API Key</label>
      <input type="text" id="apiKey" placeholder="Paste your v3 API key here…" autocomplete="off" spellcheck="false"/>
      <p class="hint">
        Get a free key at
        <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org/settings/api</a>
      </p>
    </div>

    <div class="section-label">Optional</div>

    <div class="field">
      <label for="topN">Episodes in Best Of season</label>
      <input type="number" id="topN" placeholder="20" min="5" max="100"/>
      <p class="hint">Default: 20. Higher values fetch more data and load slower.</p>
    </div>

    <button class="btn-primary" onclick="generate()">Generate Install Link →</button>

    <div id="result">
      <a id="stremio-btn" class="install-btn" href="#">⚡ Install in Stremio</a>
      <p class="or-line">— or manually add by URL —</p>
      <div class="copy-row">
        <input type="text" id="manifest-url" readonly/>
        <button class="btn-copy" id="copy-btn" onclick="copyUrl()">Copy</button>
      </div>
    </div>
  </div>

  <script>
    function generate() {
      const apiKey = document.getElementById('apiKey').value.trim();
      const topN   = document.getElementById('topN').value.trim();
      if (!apiKey) {
        const inp = document.getElementById('apiKey');
        inp.classList.add('error'); inp.focus();
        setTimeout(() => inp.classList.remove('error'), 2000);
        return;
      }
      const cfg = { tmdbApiKey: apiKey };
      if (topN) cfg.topN = parseInt(topN, 10);
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
      btn.textContent = '✓ Copied'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    }
  </script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`TMDB Metadata + Best Of addon → http://localhost:${PORT}`);
  console.log(`Configure page              → http://localhost:${PORT}/configure`);
});
