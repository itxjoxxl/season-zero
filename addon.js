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
  return tmdb('/movie/' + tmdbId, apiKey, {
    append_to_response: 'external_ids,release_dates,credits,videos',
  });
}

async function getSeries(tmdbId, apiKey) {
  return tmdb('/tv/' + tmdbId, apiKey, {
    append_to_response: 'external_ids,content_ratings,credits',
  });
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
          season:       s,
          episode:      ep.episode_number,
          name:         ep.name,
          overview:     ep.overview || '',
          still:        ep.still_path ? TMDB_IMG_SM + ep.still_path : null,
          vote_average: ep.vote_average || 0,
          vote_count:   ep.vote_count   || 0,
          air_date:     ep.air_date,
        });
      }
    } catch (e) { /* skip broken seasons */ }
  }
  return episodes;
}

async function getTopEpisodes(tmdbId, apiKey, totalSeasons, topN) {
  topN = topN || 20;
  const all = await getAllEpisodes(tmdbId, apiKey, totalSeasons);
  const filtered = all.filter(function(e) { return e.vote_count >= 5; });
  filtered.sort(function(a, b) {
    return b.vote_average - a.vote_average || b.vote_count - a.vote_count;
  });
  return filtered.slice(0, topN);
}

function getSeriesCert(data) {
  try {
    const us = (data.content_ratings && data.content_ratings.results || []).find(function(r) { return r.iso_3166_1 === 'US'; });
    return us && us.rating || null;
  } catch (e) { return null; }
}

function getMovieCert(data) {
  try {
    const us = (data.release_dates && data.release_dates.results || []).find(function(r) { return r.iso_3166_1 === 'US'; });
    const rel = (us && us.release_dates || []).find(function(d) { return d.type === 3 || d.type === 4; });
    return rel && rel.certification || null;
  } catch (e) { return null; }
}

function buildManifest(config) {
  const cfg = config ? parseConfig(config) : {};
  return {
    id:          'community.tmdb-metadata-bestof',
    version:     '2.1.0',
    name:        'TMDB Metadata + Best Of',
    description: 'Full TMDB metadata for movies & series. Injects a Best Of season into every show.',
    logo:        'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg',
    catalogs:    [],
    resources:   ['meta', 'episodeVideos'],
    types:       ['movie', 'series'],
    idPrefixes:  ['tmdb:'],
    behaviorHints: {
      configurable:          true,
      configurationRequired: !cfg.tmdbApiKey,
    },
    config: [
      { key: 'tmdbApiKey', type: 'text',   title: 'TMDB API Key',                                required: true  },
      { key: 'topN',       type: 'number', title: 'Top episodes in Best Of season (default: 20)', required: false },
    ],
  };
}

app.get('/manifest.json',         function(req, res) { res.json(buildManifest()); });
app.get('/:config/manifest.json', function(req, res) { res.json(buildManifest(req.params.config)); });

app.get('/',          function(req, res) { res.redirect('/configure'); });
app.get('/configure', function(req, res) { res.send(configurePage()); });

// FIX: validate endpoint that actually tests a real TMDB call
app.get('/api/validate', async function(req, res) {
  const apiKey = req.query.apiKey;
  if (!apiKey) return res.status(400).json({ error: 'No API key provided' });
  try {
    const data = await tmdb('/configuration', apiKey);
    if (!data || !data.images) throw new Error('Unexpected response from TMDB');
    res.json({ ok: true });
  } catch (e) {
    const status = (e.response && e.response.status) || 500;
    res.status(status).json({ error: e.message });
  }
});

app.get('/api/search', async function(req, res) {
  const q      = req.query.q;
  const apiKey = req.query.apiKey;
  if (!q || !apiKey) return res.json({ results: [] });
  try {
    const data = await tmdb('/search/tv', apiKey, { query: q });
    const results = (data.results || []).slice(0, 8).map(function(s) {
      return {
        id:           s.id,
        name:         s.name,
        poster:       s.poster_path ? TMDB_IMG_SM + s.poster_path : null,
        year:         s.first_air_date ? s.first_air_date.substring(0, 4) : '',
        vote_average: s.vote_average ? s.vote_average.toFixed(1) : '?',
      };
    });
    res.json({ results: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/episodes', async function(req, res) {
  const tmdbId = req.query.tmdbId;
  const apiKey = req.query.apiKey;
  if (!tmdbId || !apiKey) return res.json({ episodes: [] });
  try {
    const series   = await getSeries(tmdbId, apiKey);
    const episodes = await getAllEpisodes(tmdbId, apiKey, series.number_of_seasons || 1);
    res.json({
      show: {
        name:    series.name,
        poster:  series.poster_path ? TMDB_IMG_MD + series.poster_path : null,
        seasons: series.number_of_seasons,
      },
      episodes: episodes,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/:config/meta/movie/:id.json', async function(req, res) {
  const config = req.params.config;
  const id     = req.params.id;
  const cfg    = parseConfig(config);
  if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });
  if (!id.startsWith('tmdb:')) return res.json({ meta: null });

  try {
    const movie    = await getMovie(extractId(id), cfg.tmdbApiKey);
    const cert     = getMovieCert(movie);
    const director = movie.credits && movie.credits.crew && movie.credits.crew.find(function(c) { return c.job === 'Director'; });
    const cast     = (movie.credits && movie.credits.cast || []).slice(0, 8).map(function(c) { return c.name; });
    const trailerKey = movie.videos && movie.videos.results && movie.videos.results.find(function(v) {
      return v.type === 'Trailer' && v.site === 'YouTube';
    });

    const meta = {
      id:           id,
      type:         'movie',
      name:         movie.title,
      poster:       movie.poster_path   ? TMDB_IMG_MD + movie.poster_path   : null,
      background:   movie.backdrop_path ? TMDB_IMG_LG + movie.backdrop_path : null,
      description:  movie.overview,
      releaseInfo:  movie.release_date ? movie.release_date.substring(0, 4) : '',
      runtime:      movie.runtime      ? movie.runtime + ' min'             : null,
      genres:       (movie.genres || []).map(function(g) { return g.name; }),
      imdbRating:   movie.vote_average  ? movie.vote_average.toFixed(1)     : null,
      cast:         cast,
      director:     director ? director.name : null,
      certification: cert || null,
      trailers:     trailerKey ? [{ source: 'yt', type: 'Trailer', ytId: trailerKey.key }] : [],
      links:        movie.external_ids && movie.external_ids.imdb_id
        ? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' + movie.external_ids.imdb_id }]
        : [],
    };
    res.json({ meta: meta });
  } catch (e) {
    console.error('[movie meta]', e.message);
    res.status(500).json({ err: e.message });
  }
});

app.get('/:config/meta/series/:id.json', async function(req, res) {
  const config = req.params.config;
  const id     = req.params.id;
  const cfg    = parseConfig(config);
  if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key' });
  if (!id.startsWith('tmdb:')) return res.json({ meta: null });

  const tmdbId = extractId(id);
  const topN   = parseInt(cfg.topN) || 20;

  try {
    const series = await getSeries(tmdbId, cfg.tmdbApiKey);
    const cert   = getSeriesCert(series);
    const cast   = (series.credits && series.credits.cast || []).slice(0, 8).map(function(c) { return c.name; });
    const videos = [];

    for (let s = 1; s <= (series.number_of_seasons || 0); s++) {
      try {
        const season = await getSeason(tmdbId, s, cfg.tmdbApiKey);
        for (const ep of (season.episodes || [])) {
          videos.push({
            id:        id + ':' + s + ':' + ep.episode_number,
            title:     ep.name || 'Episode ' + ep.episode_number,
            season:    s,
            episode:   ep.episode_number,
            overview:  ep.overview || '',
            thumbnail: ep.still_path ? TMDB_IMG_SM + ep.still_path : null,
            released:  ep.air_date  ? new Date(ep.air_date) : null,
            rating:    ep.vote_average ? ep.vote_average.toFixed(1) : null,
          });
        }
      } catch (e) { /* skip */ }
    }

    const customSeasons = cfg.customSeasons || {};
    const customList    = customSeasons[tmdbId];
    let bestOfEps = [];

    if (customList && customList.length > 0) {
      const allEps = await getAllEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1);
      for (const ref of customList) {
        const ep = allEps.find(function(e) { return e.season === ref.season && e.episode === ref.episode; });
        if (ep) bestOfEps.push(ep);
      }
    } else {
      bestOfEps = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN);
    }

    bestOfEps.forEach(function(ep, i) {
      const rank   = i + 1;
      const sLabel = String(ep.season).padStart(2, '0');
      const eLabel = String(ep.episode).padStart(2, '0');
      const ratingLine = ep.vote_average > 0
        ? ep.vote_average.toFixed(1) + '/10  (' + ep.vote_count.toLocaleString() + ' votes)\n\n'
        : '';
      videos.push({
        id:        id + ':0:' + rank,
        title:     '#' + rank + ' - S' + sLabel + 'E' + eLabel + ' - ' + ep.name,
        season:    0,
        episode:   rank,
        overview:  ratingLine + (ep.overview || ''),
        thumbnail: ep.still || null,
        released:  ep.air_date ? new Date(ep.air_date) : null,
      });
    });

    const startYear  = series.first_air_date ? series.first_air_date.substring(0, 4) : '';
    const endYear    = series.last_air_date   ? series.last_air_date.substring(0, 4)  : '';
    const releaseInfo = series.status === 'Ended' && endYear
      ? startYear + '-' + endYear
      : startYear;

    const meta = {
      id:            id,
      type:          'series',
      name:          series.name,
      poster:        series.poster_path   ? TMDB_IMG_MD + series.poster_path   : null,
      background:    series.backdrop_path ? TMDB_IMG_LG + series.backdrop_path : null,
      description:   series.overview,
      releaseInfo:   releaseInfo,
      runtime:       series.episode_run_time && series.episode_run_time[0] ? series.episode_run_time[0] + ' min' : null,
      genres:        (series.genres || []).map(function(g) { return g.name; }),
      imdbRating:    series.vote_average ? series.vote_average.toFixed(1) : null,
      cast:          cast,
      certification: cert || null,
      videos:        videos,
      links:         series.external_ids && series.external_ids.imdb_id
        ? [{ name: 'IMDb', category: 'imdb', url: 'https://www.imdb.com/title/' + series.external_ids.imdb_id }]
        : [],
    };
    res.json({ meta: meta });
  } catch (e) {
    console.error('[series meta]', e.message);
    res.status(500).json({ err: e.message });
  }
});

app.get('/:config/episodeVideos/series/:id.json', async function(req, res) {
  const config = req.params.config;
  const id     = req.params.id;
  const cfg    = parseConfig(config);
  if (!cfg.tmdbApiKey) return res.json({ videos: [] });

  const parts = id.split(':');
  if (parts.length < 4 || parts[0] !== 'tmdb') return res.json({ videos: [] });

  const tmdbId     = parts[1];
  const season     = parseInt(parts[2]);
  const episodeNum = parseInt(parts[3]);
  const topN       = parseInt(cfg.topN) || 20;

  if (season !== 0) return res.json({ videos: [] });

  try {
    const series        = await getSeries(tmdbId, cfg.tmdbApiKey);
    const customSeasons = cfg.customSeasons || {};
    const customList    = customSeasons[tmdbId];
    let target;

    if (customList && customList.length > 0) {
      const allEps = await getAllEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1);
      const ref    = customList[episodeNum - 1];
      if (!ref) return res.json({ videos: [] });
      target = allEps.find(function(e) { return e.season === ref.season && e.episode === ref.episode; });
    } else {
      const topEps = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN);
      target = topEps[episodeNum - 1];
    }

    if (!target) return res.json({ videos: [] });

    res.json({
      videos: [{
        id:        'tmdb:' + tmdbId + ':' + target.season + ':' + target.episode,
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


function configurePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>TMDB Best Of - Configure</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
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
    .topbar {
      background: var(--surface); border-bottom: 1px solid var(--border);
      padding: 0 2rem; height: 60px; display: flex; align-items: center; gap: 1rem;
      position: sticky; top: 0; z-index: 100;
    }
    .topbar-logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 1rem; color: #fff; }
    .topbar-steps { display: flex; align-items: center; gap: 0; margin-left: auto; }
    .step-item { display: flex; align-items: center; gap: 8px; font-size: 0.78rem; color: var(--text-dim); padding: 6px 14px; }
    .step-item.active { color: var(--accent); }
    .step-item.done { color: var(--accent2); }
    .step-num {
      width: 22px; height: 22px; border-radius: 50%;
      background: var(--surface2); border: 1.5px solid var(--border2);
      display: flex; align-items: center; justify-content: center;
      font-size: 0.7rem; font-weight: 700;
    }
    .step-item.active .step-num { background: var(--accent); border-color: var(--accent); color: #fff; }
    .step-item.done .step-num { background: var(--accent2); border-color: var(--accent2); color: #000; }
    .step-divider { color: var(--text-mute); font-size: 0.7rem; }
    .main { flex: 1; padding: 2.5rem 2rem; max-width: 820px; margin: 0 auto; width: 100%; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 2rem 2rem 2.2rem; margin-bottom: 1.4rem; }
    .card-title { font-size: 1rem; font-weight: 700; color: #fff; margin-bottom: 0.25rem; }
    .card-sub { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 1.5rem; }
    .field { margin-bottom: 1.2rem; }
    label { display: block; font-size: 0.78rem; font-weight: 600; color: var(--text-dim); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    input[type=text], input[type=number], input[type=password] {
      width: 100%; background: var(--bg); border: 1.5px solid var(--border2);
      border-radius: var(--radius); padding: 11px 14px;
      color: var(--text); font-size: 0.93rem; font-family: inherit;
      outline: none; transition: border-color 0.15s;
    }
    input:focus { border-color: var(--accent); }
    input.error { border-color: var(--danger) !important; animation: shake 0.3s; }
    @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
    .hint { font-size: 0.72rem; color: var(--text-mute); margin-top: 5px; }
    .hint a { color: var(--accent); text-decoration: none; }
    .error-msg { font-size: 0.78rem; color: var(--danger); margin-top: 8px; padding: 8px 12px; background: rgba(224,82,82,0.1); border-radius: 8px; border: 1px solid rgba(224,82,82,0.2); display: none; }
    .error-msg.visible { display: block; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      padding: 10px 20px; border-radius: var(--radius);
      font-size: 0.88rem; font-weight: 600; font-family: inherit;
      cursor: pointer; border: none; transition: all 0.15s;
    }
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
    .show-season-card { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; margin-bottom: 12px; background: var(--surface2); }
    .show-season-header { display: flex; align-items: center; gap: 14px; padding: 14px 16px; cursor: pointer; transition: background 0.12s; }
    .show-season-header:hover { background: var(--bg); }
    .show-season-poster { width: 32px; height: 48px; border-radius: 5px; object-fit: cover; background: var(--surface); flex-shrink: 0; }
    .show-season-name { flex: 1; font-size: 0.9rem; font-weight: 700; color: #fff; }
    .show-season-count { font-size: 0.72rem; color: var(--text-dim); }
    .show-season-chevron { color: var(--text-mute); transition: transform 0.2s; font-size: 0.8rem; }
    .show-season-card.open .show-season-chevron { transform: rotate(90deg); }
    .show-season-body { display: none; border-top: 1px solid var(--border); padding: 14px 16px; }
    .show-season-card.open .show-season-body { display: block; }
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
    .ep-list-actions { display: flex; gap: 8px; margin-top: 10px; }
    .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 500; align-items: center; justify-content: center; padding: 1.5rem; }
    .modal-backdrop.open { display: flex; }
    .modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 20px; max-width: 580px; width: 100%; max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; }
    .modal-header { padding: 1.4rem 1.6rem 1rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 14px; }
    .modal-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }
    .modal-title { font-size: 1rem; font-weight: 700; color: #fff; }
    .modal-sub { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }
    .modal-close { margin-left: auto; color: var(--text-mute); cursor: pointer; font-size: 1.3rem; line-height: 1; padding: 4px 8px; }
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
    @media (max-width: 540px) { .features-grid { grid-template-columns: 1fr; } .main { padding: 1.5rem 1rem; } }
  </style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="topbar-logo">&#127916; TMDB Best Of</div>
    <div class="topbar-steps">
      <div class="step-item active" id="step-tab-1"><span class="step-num">1</span><span>API Key</span></div>
      <span class="step-divider">&rsaquo;</span>
      <div class="step-item" id="step-tab-2"><span class="step-num">2</span><span>Custom Seasons</span></div>
      <span class="step-divider">&rsaquo;</span>
      <div class="step-item" id="step-tab-3"><span class="step-num">3</span><span>Install</span></div>
    </div>
  </div>
  <div class="main">

    <div class="page active" id="page-1">
      <div class="card">
        <div style="text-align:center;padding:1rem 0 1.8rem;font-size:4rem;opacity:0.6">&#128273;</div>
        <div class="card-title">Connect to TMDB</div>
        <div class="card-sub">Enter your free TMDB API key to get started.</div>
        <div class="features-grid">
          <div class="feature-chip">&#127916; Movie metadata</div>
          <div class="feature-chip">&#128250; Series metadata</div>
          <div class="feature-chip">&#11088; Auto Best Of season</div>
          <div class="feature-chip">&#9999;&#65039; Custom episode lists</div>
        </div>
        <div class="field">
          <label>TMDB API Key (v3)</label>
          <input type="password" id="apiKey" placeholder="Paste your API key here..." autocomplete="off" spellcheck="false"/>
          <p class="hint">Free key from <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a></p>
          <div class="error-msg" id="api-error">Could not validate API key. Please check it and try again.</div>
        </div>
        <div class="field">
          <label>Default top episodes count</label>
          <input type="number" id="topN" placeholder="20" min="5" max="100"/>
          <p class="hint">For shows without a custom season, show the top N rated episodes. Default: 20.</p>
        </div>
        <button class="btn btn-primary btn-lg" style="width:100%" onclick="validateApiKey()" id="btn-validate">Continue &rarr;</button>
      </div>
    </div>

    <div class="page" id="page-2">
      <div class="card">
        <div class="card-title">&#9999;&#65039; Custom Best Of Seasons</div>
        <div class="card-sub">Search for a show and hand-pick which episodes appear in its Best Of season in any order you like. Shows without a custom season fall back to auto top-rated.</div>
        <div class="search-wrap field">
          <span class="search-icon">&#128269;</span>
          <input type="text" id="series-search" placeholder="Search for a TV show..." autocomplete="off"/>
        </div>
        <div id="search-results" class="search-results"></div>
      </div>
      <div class="card">
        <div class="section-header">
          <span class="section-title">Your custom seasons</span>
          <span id="custom-count" style="font-size:0.75rem;color:var(--text-dim)"></span>
        </div>
        <div id="custom-seasons-list">
          <div class="custom-seasons-empty">No custom seasons yet. Search for a show above to get started.</div>
        </div>
      </div>
      <div class="nav-row">
        <button class="btn btn-secondary" onclick="goTo(1)">&larr; Back</button>
        <button class="btn btn-gold btn-lg" onclick="goTo(3)">Generate Install Link &rarr;</button>
      </div>
    </div>

    <div class="page" id="page-3">
      <div class="card">
        <div class="generate-hero">
          <div style="font-size:3.5rem;margin-bottom:12px">&#128640;</div>
          <h2>Ready to install!</h2>
          <p>Your addon is configured. Click below to add it directly to Stremio.</p>
        </div>
        <div id="install-summary"></div>
        <button class="btn btn-install" onclick="openStremio()">&#9889; Install in Stremio</button>
        <div class="or-line">-- or add manually --</div>
        <div class="copy-row">
          <input type="text" id="manifest-url" readonly/>
          <button class="btn-copy" id="copy-btn" onclick="copyUrl()">Copy</button>
        </div>
      </div>
      <div class="nav-row">
        <button class="btn btn-secondary" onclick="goTo(2)">&larr; Back</button>
      </div>
    </div>

  </div>
</div>

<div class="modal-backdrop" id="modal-backdrop" onclick="closeModalOnBackdrop(event)">
  <div class="modal">
    <div class="modal-header">
      <img class="modal-poster" id="modal-poster" src="" alt=""/>
      <div><div class="modal-title" id="modal-show-name">Loading...</div><div class="modal-sub" id="modal-show-sub"></div></div>
      <span class="modal-close" onclick="closeModal()">&times;</span>
    </div>
    <div class="modal-filter" id="modal-season-filters"></div>
    <div class="modal-ep-list" id="modal-ep-list">
      <div class="loading-overlay"><div class="spinner"></div> Loading episodes...</div>
    </div>
    <div class="modal-footer">
      <span class="modal-selected-count">Selected: <span id="modal-sel-count">0</span></span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="addSelectedEpisodes()">Add to Season</button>
      </div>
    </div>
  </div>
</div>

<script>
// ─── State ────────────────────────────────────────────────────────────────────
var state = { apiKey: '', topN: 20, customSeasons: {} };
var modalData = {
  tmdbId: null, tmdbName: null, tmdbPoster: null,
  allEpisodes: [], filteredSeason: 'all', selected: new Set()
};

// ─── Navigation ───────────────────────────────────────────────────────────────
function goTo(n) {
  document.querySelectorAll('.page').forEach(function(p, i) {
    p.classList.toggle('active', i + 1 === n);
  });
  document.querySelectorAll('[id^=step-tab-]').forEach(function(el, i) {
    var num = i + 1;
    el.classList.remove('active', 'done');
    if (num === n) el.classList.add('active');
    else if (num < n) el.classList.add('done');
  });
  if (n === 3) buildInstallPage();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── API Key Validation (FIX: use dedicated /api/validate endpoint) ───────────
async function validateApiKey() {
  var input   = document.getElementById('apiKey');
  var errBox  = document.getElementById('api-error');
  var btn     = document.getElementById('btn-validate');
  var key     = input.value.trim();

  errBox.classList.remove('visible');
  if (!key) { flashError(input); errBox.textContent = 'Please enter your API key.'; errBox.classList.add('visible'); return; }

  btn.innerHTML = '<span class="spinner"></span> Validating...';
  btn.disabled = true;

  try {
    var r = await fetch('/api/validate?apiKey=' + encodeURIComponent(key));
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'Invalid API key');
    state.apiKey = key;
    state.topN = parseInt(document.getElementById('topN').value) || 20;
    goTo(2);
  } catch (e) {
    flashError(input);
    errBox.textContent = 'Error: ' + e.message;
    errBox.classList.add('visible');
  } finally {
    btn.innerHTML = 'Continue &rarr;';
    btn.disabled = false;
  }
}

// Allow Enter key on API key input
document.getElementById('apiKey').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') validateApiKey();
});

function flashError(el) {
  el.classList.add('error');
  el.focus();
  setTimeout(function() { el.classList.remove('error'); }, 2000);
}

// ─── Search (FIX: use data attributes instead of inline onclick with string interpolation) ──
var searchTimer;
document.getElementById('series-search').addEventListener('input', function() {
  var q = this.value.trim();
  clearTimeout(searchTimer);
  if (!q) { document.getElementById('search-results').classList.remove('visible'); return; }
  searchTimer = setTimeout(function() { doSearch(q); }, 350);
});

async function doSearch(q) {
  var box = document.getElementById('search-results');
  box.classList.add('visible');
  box.innerHTML = '<div class="loading-overlay"><div class="spinner"></div> Searching...</div>';
  try {
    var r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&apiKey=' + encodeURIComponent(state.apiKey));
    var d = await r.json();
    if (!d.results || !d.results.length) {
      box.innerHTML = '<p style="padding:1rem;font-size:0.82rem;color:var(--text-mute)">No results found.</p>';
      return;
    }
    box.innerHTML = '';
    d.results.forEach(function(s) {
      var item = document.createElement('div');
      item.className = 'search-result-item';
      // FIX: use dataset instead of error-prone onclick string building
      item.dataset.tmdbId = s.id;
      item.dataset.name   = s.name;
      item.dataset.poster = s.poster || '';
      item.addEventListener('click', function() {
        openModal(
          parseInt(this.dataset.tmdbId),
          this.dataset.name,
          this.dataset.poster
        );
      });
      var posterHtml = s.poster
        ? '<img class="search-poster" src="' + escAttr(s.poster) + '" alt="" loading="lazy"/>'
        : '<div class="search-poster" style="display:flex;align-items:center;justify-content:center;color:var(--text-mute)">&#128250;</div>';
      item.innerHTML = posterHtml +
        '<div><div class="search-name">' + esc(s.name) + '</div>' +
        '<div class="search-meta">' + (s.year ? s.year + ' &middot; ' : '') + '&#11088; ' + s.vote_average + '</div></div>';
      box.appendChild(item);
    });
  } catch (e) {
    box.innerHTML = '<p style="padding:1rem;color:var(--text-mute)">Error searching: ' + esc(e.message) + '</p>';
  }
}

// ─── Modal ────────────────────────────────────────────────────────────────────
async function openModal(tmdbId, name, poster) {
  modalData.tmdbId   = tmdbId;
  modalData.tmdbName = name;
  modalData.tmdbPoster = poster;
  modalData.allEpisodes = [];
  modalData.filteredSeason = 'all';
  var existing = (state.customSeasons[tmdbId] && state.customSeasons[tmdbId].episodes) || [];
  modalData.selected = new Set(existing.map(function(e) { return e.season + ':' + e.episode; }));

  document.getElementById('modal-show-name').textContent = name;
  document.getElementById('modal-show-sub').textContent  = 'Loading...';
  document.getElementById('modal-poster').src = poster || '';
  document.getElementById('modal-season-filters').innerHTML = '';
  document.getElementById('modal-ep-list').innerHTML =
    '<div class="loading-overlay"><div class="spinner"></div> Loading episodes...</div>';
  updateModalCount();
  document.getElementById('modal-backdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('search-results').classList.remove('visible');
  document.getElementById('series-search').value = '';

  try {
    var r = await fetch('/api/episodes?tmdbId=' + tmdbId + '&apiKey=' + encodeURIComponent(state.apiKey));
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    modalData.allEpisodes = d.episodes;
    document.getElementById('modal-show-sub').textContent =
      d.show.seasons + ' season' + (d.show.seasons !== 1 ? 's' : '') + ' - ' + d.episodes.length + ' episodes';

    var seasons = [];
    d.episodes.forEach(function(e) { if (seasons.indexOf(e.season) === -1) seasons.push(e.season); });
    seasons.sort(function(a, b) { return a - b; });

    var filtersEl = document.getElementById('modal-season-filters');
    // FIX: build filter buttons with addEventListener, not onclick strings
    var allBtn = document.createElement('button');
    allBtn.className = 'season-filter-btn active';
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', function() { setSeasonFilter('all', this); });
    filtersEl.appendChild(allBtn);
    seasons.forEach(function(s) {
      var btn = document.createElement('button');
      btn.className = 'season-filter-btn';
      btn.textContent = 'S' + s;
      btn.addEventListener('click', function() { setSeasonFilter(s, this); });
      filtersEl.appendChild(btn);
    });

    renderModalEpisodes();
  } catch (e) {
    document.getElementById('modal-ep-list').innerHTML =
      '<p style="padding:1rem;color:var(--text-mute)">Error: ' + esc(e.message) + '</p>';
  }
}

function setSeasonFilter(val, btn) {
  modalData.filteredSeason = val;
  document.querySelectorAll('.season-filter-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderModalEpisodes();
}

function renderModalEpisodes() {
  var eps = modalData.filteredSeason === 'all'
    ? modalData.allEpisodes
    : modalData.allEpisodes.filter(function(e) { return e.season === modalData.filteredSeason; });
  var list = document.getElementById('modal-ep-list');
  if (!eps.length) { list.innerHTML = '<p style="padding:1rem;color:var(--text-mute)">No episodes.</p>'; return; }

  list.innerHTML = '';
  eps.forEach(function(ep) {
    var key    = ep.season + ':' + ep.episode;
    var sel    = modalData.selected.has(key);
    var sLabel = String(ep.season).padStart(2, '0');
    var eLabel = String(ep.episode).padStart(2, '0');

    var item = document.createElement('div');
    item.className = 'modal-ep-item' + (sel ? ' selected' : '');
    // FIX: store key as data attribute and use addEventListener
    item.dataset.key = key;
    item.addEventListener('click', function() { toggleEp(this.dataset.key, this); });

    var thumbHtml = ep.still
      ? '<img class="modal-ep-thumb" src="' + escAttr(ep.still) + '" alt="" loading="lazy"/>'
      : '<div class="modal-ep-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--text-mute)">&#127902;</div>';

    item.innerHTML = thumbHtml +
      '<div class="modal-ep-info">' +
        '<div class="modal-ep-name">S' + sLabel + 'E' + eLabel + ' - ' + esc(ep.name) + '</div>' +
        '<div class="modal-ep-meta">' + (ep.vote_average > 0 ? '&#11088; ' + ep.vote_average.toFixed(1) + ' &middot; ' : '') + esc(ep.air_date || '') + '</div>' +
      '</div>' +
      '<div class="modal-ep-check">' + (sel ? '&#10003;' : '') + '</div>';

    list.appendChild(item);
  });
}

function toggleEp(key, el) {
  if (modalData.selected.has(key)) {
    modalData.selected.delete(key);
    el.classList.remove('selected');
    el.querySelector('.modal-ep-check').innerHTML = '';
  } else {
    modalData.selected.add(key);
    el.classList.add('selected');
    el.querySelector('.modal-ep-check').innerHTML = '&#10003;';
  }
  updateModalCount();
}

function updateModalCount() {
  document.getElementById('modal-sel-count').textContent = modalData.selected.size;
}

function addSelectedEpisodes() {
  var keys = Array.from(modalData.selected);
  var episodes = keys.map(function(k) {
    var parts = k.split(':').map(Number);
    return modalData.allEpisodes.find(function(ep) { return ep.season === parts[0] && ep.episode === parts[1]; });
  }).filter(Boolean);

  var existing    = (state.customSeasons[modalData.tmdbId] && state.customSeasons[modalData.tmdbId].episodes) || [];
  var existingKeys = new Set(existing.map(function(e) { return e.season + ':' + e.episode; }));
  var newEps      = episodes.filter(function(e) { return !existingKeys.has(e.season + ':' + e.episode); });
  var kept        = existing.filter(function(e) { return keys.indexOf(e.season + ':' + e.episode) !== -1; });
  var merged      = kept.concat(newEps);

  if (merged.length === 0) {
    delete state.customSeasons[modalData.tmdbId];
  } else {
    state.customSeasons[modalData.tmdbId] = {
      name:    modalData.tmdbName,
      poster:  modalData.tmdbPoster,
      tmdbId:  modalData.tmdbId,
      episodes: merged,
    };
  }
  closeModal();
  renderCustomSeasonsList();
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.remove('open');
  document.body.style.overflow = '';
}
function closeModalOnBackdrop(e) {
  if (e.target === document.getElementById('modal-backdrop')) closeModal();
}

// ─── Custom Seasons List (FIX: use DOM methods instead of HTML string building) ──
function renderCustomSeasonsList() {
  var el  = document.getElementById('custom-seasons-list');
  var cnt = document.getElementById('custom-count');
  var ids = Object.keys(state.customSeasons);
  cnt.textContent = ids.length ? ids.length + ' show' + (ids.length > 1 ? 's' : '') : '';

  if (!ids.length) {
    el.innerHTML = '<div class="custom-seasons-empty">No custom seasons yet. Search for a show above to get started.</div>';
    return;
  }

  el.innerHTML = '';
  ids.forEach(function(tid) {
    var show = state.customSeasons[tid];

    var card = document.createElement('div');
    card.className = 'show-season-card';
    card.id = 'card-' + tid;

    // Header
    var header = document.createElement('div');
    header.className = 'show-season-header';
    header.addEventListener('click', function() { card.classList.toggle('open'); });

    var posterEl;
    if (show.poster) {
      posterEl = document.createElement('img');
      posterEl.className = 'show-season-poster';
      posterEl.src = show.poster;
      posterEl.alt = '';
      posterEl.loading = 'lazy';
    } else {
      posterEl = document.createElement('div');
      posterEl.className = 'show-season-poster';
      posterEl.style.cssText = 'display:flex;align-items:center;justify-content:center;color:var(--text-mute)';
      posterEl.innerHTML = '&#128250;';
    }

    var nameSpan  = document.createElement('span');
    nameSpan.className = 'show-season-name';
    nameSpan.textContent = show.name;

    var countSpan = document.createElement('span');
    countSpan.className = 'show-season-count';
    countSpan.textContent = show.episodes.length + ' ep' + (show.episodes.length !== 1 ? 's' : '');

    var chevron = document.createElement('span');
    chevron.className = 'show-season-chevron';
    chevron.innerHTML = '&rsaquo;';

    header.appendChild(posterEl);
    header.appendChild(nameSpan);
    header.appendChild(countSpan);
    header.appendChild(chevron);

    // Body
    var body = document.createElement('div');
    body.className = 'show-season-body';

    var ul = document.createElement('ul');
    ul.className = 'ep-list';
    ul.id = 'eplist-' + tid;
    ul.dataset.tid = tid;

    show.episodes.forEach(function(ep, i) {
      var sLabel = String(ep.season).padStart(2, '0');
      var eLabel = String(ep.episode).padStart(2, '0');
      var li = document.createElement('li');
      li.className = 'ep-item';
      li.draggable = true;
      li.dataset.tid = tid;
      li.dataset.idx = i;

      var thumbEl;
      if (ep.still) {
        thumbEl = document.createElement('img');
        thumbEl.className = 'ep-thumb';
        thumbEl.src = ep.still;
        thumbEl.alt = '';
        thumbEl.loading = 'lazy';
      } else {
        thumbEl = document.createElement('div');
        thumbEl.className = 'ep-thumb';
        thumbEl.style.cssText = 'display:flex;align-items:center;justify-content:center;color:var(--text-mute)';
        thumbEl.innerHTML = '&#127902;';
      }

      var rankSpan = document.createElement('span');
      rankSpan.className = 'ep-rank';
      rankSpan.textContent = i + 1;

      var dragSpan = document.createElement('span');
      dragSpan.className = 'ep-drag';
      dragSpan.innerHTML = '&#8943;';

      var infoDiv = document.createElement('div');
      infoDiv.className = 'ep-info';
      infoDiv.innerHTML =
        '<div class="ep-label">S' + sLabel + 'E' + eLabel + ' - ' + esc(ep.name) + '</div>' +
        '<div class="ep-sublabel">' + esc(ep.air_date || '') + '</div>';

      var delSpan = document.createElement('span');
      delSpan.className = 'ep-del';
      delSpan.title = 'Remove';
      delSpan.innerHTML = '&times;';
      delSpan.addEventListener('click', function(e) {
        e.stopPropagation();
        removeEp(tid, i);
      });

      li.appendChild(rankSpan);
      li.appendChild(dragSpan);
      li.appendChild(thumbEl);
      li.appendChild(infoDiv);

      if (ep.vote_average > 0) {
        var ratingSpan = document.createElement('span');
        ratingSpan.className = 'ep-rating';
        ratingSpan.innerHTML = '&#11088;' + ep.vote_average.toFixed(1);
        li.appendChild(ratingSpan);
      }

      li.appendChild(delSpan);
      ul.appendChild(li);
    });

    var actions = document.createElement('div');
    actions.className = 'ep-list-actions';

    var editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = 'Edit Episodes';
    editBtn.addEventListener('click', function() {
      openModal(parseInt(tid), show.name, show.poster || '');
    });

    var removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger btn-sm';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function() { removeSeason(tid); });

    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);
    body.appendChild(ul);
    body.appendChild(actions);

    card.appendChild(header);
    card.appendChild(body);
    el.appendChild(card);

    initDragSort(tid);
  });
}

function removeSeason(tid) { delete state.customSeasons[tid]; renderCustomSeasonsList(); }
function removeEp(tid, idx) {
  state.customSeasons[tid].episodes.splice(idx, 1);
  if (!state.customSeasons[tid].episodes.length) delete state.customSeasons[tid];
  renderCustomSeasonsList();
}

function initDragSort(tid) {
  var list = document.getElementById('eplist-' + tid);
  if (!list) return;
  var dragIdx = null;
  list.querySelectorAll('.ep-item').forEach(function(item, idx) {
    item.addEventListener('dragstart', function(e) {
      dragIdx = idx;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', function() { item.classList.remove('dragging'); });
    item.addEventListener('dragover', function(e) {
      e.preventDefault();
      list.querySelectorAll('.ep-item').forEach(function(i) { i.classList.remove('drag-over'); });
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', function() { item.classList.remove('drag-over'); });
    item.addEventListener('drop', function(e) {
      e.preventDefault();
      item.classList.remove('drag-over');
      var dropIdx = parseInt(item.dataset.idx);
      if (dragIdx === null || dragIdx === dropIdx) return;
      var eps   = state.customSeasons[tid].episodes;
      var moved = eps.splice(dragIdx, 1)[0];
      eps.splice(dropIdx, 0, moved);
      renderCustomSeasonsList();
      var card = document.getElementById('card-' + tid);
      if (card) card.classList.add('open');
    });
  });
}

// ─── Install Page ─────────────────────────────────────────────────────────────
function buildInstallPage() {
  var customSeasonsFlat = {};
  Object.keys(state.customSeasons).forEach(function(tid) {
    customSeasonsFlat[tid] = state.customSeasons[tid].episodes.map(function(e) {
      return { season: e.season, episode: e.episode };
    });
  });
  var cfg     = { tmdbApiKey: state.apiKey, topN: state.topN, customSeasons: customSeasonsFlat };
  var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
  var base    = window.location.origin;
  var manifestUrl = base + '/' + encoded + '/manifest.json';

  document.getElementById('manifest-url').value = manifestUrl;

  var showCount = Object.keys(state.customSeasons).length;
  var summary = document.getElementById('install-summary');
  summary.innerHTML =
    '<div class="summary-row"><span class="summary-label">Custom seasons</span>' +
    '<span class="summary-value ' + (showCount > 0 ? 'gold' : '') + '">' +
      (showCount > 0 ? showCount + ' show' + (showCount !== 1 ? 's' : '') : 'None (auto-ranked)') +
    '</span></div>' +
    '<div class="summary-row" style="margin-bottom:1.4rem"><span class="summary-label">Default top N</span>' +
    '<span class="summary-value accent">' + state.topN + ' episodes</span></div>';
}

function openStremio() {
  var url = document.getElementById('manifest-url').value;
  if (!url) return;
  window.location.href = url.replace(/^https?:\\/\\//, 'stremio://');
}

function copyUrl() {
  var input = document.getElementById('manifest-url');
  input.select();
  try { document.execCommand('copy'); } catch (e) {
    navigator.clipboard && navigator.clipboard.writeText(input.value);
  }
  var btn = document.getElementById('copy-btn');
  btn.textContent = 'Copied!';
  btn.classList.add('copied');
  setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
}

const PORT = process.env.PORT || 7000;
app.listen(PORT, function() {
  console.log('TMDB Best Of addon running on port ' + PORT);
  console.log('Configure page: http://localhost:' + PORT + '/configure');
});