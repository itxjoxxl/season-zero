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
  return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\"/>\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"/>\n  <title>TMDB Best Of - Configure</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link href=\"https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap\" rel=\"stylesheet\">\n  <style>\n    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n    :root {\n      --bg: #080b10; --surface: #0e1219; --surface2: #131820;\n      --border: #1e2530; --border2: #2a3340;\n      --text: #c8d4e0; --text-dim: #5a6878; --text-mute: #3a4555;\n      --accent: #3d9be9; --accent2: #56cfb0; --gold: #f0b429;\n      --purple: #8b5cf6; --danger: #e05252; --radius: 12px;\n    }\n    body { background: var(--bg); color: var(--text); font-family: \"DM Sans\", sans-serif; min-height: 100vh; }\n    .app { display: flex; flex-direction: column; min-height: 100vh; }\n    .topbar {\n      background: var(--surface); border-bottom: 1px solid var(--border);\n      padding: 0 2rem; height: 60px; display: flex; align-items: center; gap: 1rem;\n      position: sticky; top: 0; z-index: 100;\n    }\n    .topbar-logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 1rem; color: #fff; }\n    .topbar-steps { display: flex; align-items: center; gap: 0; margin-left: auto; }\n    .step-item { display: flex; align-items: center; gap: 8px; font-size: 0.78rem; color: var(--text-dim); padding: 6px 14px; }\n    .step-item.active { color: var(--accent); }\n    .step-item.done { color: var(--accent2); }\n    .step-num {\n      width: 22px; height: 22px; border-radius: 50%;\n      background: var(--surface2); border: 1.5px solid var(--border2);\n      display: flex; align-items: center; justify-content: center;\n      font-size: 0.7rem; font-weight: 700;\n    }\n    .step-item.active .step-num { background: var(--accent); border-color: var(--accent); color: #fff; }\n    .step-item.done .step-num { background: var(--accent2); border-color: var(--accent2); color: #000; }\n    .step-divider { color: var(--text-mute); font-size: 0.7rem; }\n    .main { flex: 1; padding: 2.5rem 2rem; max-width: 820px; margin: 0 auto; width: 100%; }\n    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 2rem 2rem 2.2rem; margin-bottom: 1.4rem; }\n    .card-title { font-size: 1rem; font-weight: 700; color: #fff; margin-bottom: 0.25rem; }\n    .card-sub { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 1.5rem; }\n    .field { margin-bottom: 1.2rem; }\n    label { display: block; font-size: 0.78rem; font-weight: 600; color: var(--text-dim); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }\n    input[type=text], input[type=number], input[type=password] {\n      width: 100%; background: var(--bg); border: 1.5px solid var(--border2);\n      border-radius: var(--radius); padding: 11px 14px;\n      color: var(--text); font-size: 0.93rem; font-family: inherit;\n      outline: none; transition: border-color 0.15s;\n    }\n    input:focus { border-color: var(--accent); }\n    input.error { border-color: var(--danger) !important; animation: shake 0.3s; }\n    @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }\n    .hint { font-size: 0.72rem; color: var(--text-mute); margin-top: 5px; }\n    .hint a { color: var(--accent); text-decoration: none; }\n    .btn {\n      display: inline-flex; align-items: center; justify-content: center; gap: 7px;\n      padding: 10px 20px; border-radius: var(--radius);\n      font-size: 0.88rem; font-weight: 600; font-family: inherit;\n      cursor: pointer; border: none; transition: all 0.15s;\n    }\n    .btn-primary { background: var(--accent); color: #fff; }\n    .btn-primary:hover { opacity: 0.85; }\n    .btn-secondary { background: var(--surface2); border: 1.5px solid var(--border2); color: var(--text); }\n    .btn-secondary:hover { border-color: var(--accent); color: var(--accent); }\n    .btn-danger { background: var(--danger); color: #fff; }\n    .btn-danger:hover { opacity: 0.85; }\n    .btn-gold { background: var(--gold); color: #000; }\n    .btn-gold:hover { opacity: 0.85; }\n    .btn-install { background: var(--purple); color: #fff; width: 100%; font-size: 1rem; padding: 14px; border-radius: var(--radius); }\n    .btn-install:hover { opacity: 0.85; }\n    .btn-lg { padding: 13px 28px; font-size: 0.95rem; }\n    .btn-sm { padding: 6px 12px; font-size: 0.75rem; }\n    .page { display: none; }\n    .page.active { display: block; }\n    .features-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 1.8rem; }\n    .feature-chip { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 0.8rem; color: var(--text-dim); display: flex; align-items: center; gap: 8px; }\n    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.2rem; }\n    .section-title { font-size: 0.82rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; }\n    .search-wrap { position: relative; }\n    .search-wrap input { padding-left: 42px; }\n    .search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--text-mute); pointer-events: none; }\n    .search-results { margin-top: 10px; display: none; }\n    .search-results.visible { display: block; }\n    .search-result-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; cursor: pointer; transition: background 0.12s; border: 1px solid transparent; }\n    .search-result-item:hover { background: var(--surface2); border-color: var(--border); }\n    .search-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }\n    .search-name { font-size: 0.88rem; font-weight: 600; color: var(--text); }\n    .search-meta { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }\n    .custom-seasons-empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-mute); font-size: 0.83rem; }\n    .show-season-card { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; margin-bottom: 12px; background: var(--surface2); }\n    .show-season-header { display: flex; align-items: center; gap: 14px; padding: 14px 16px; cursor: pointer; transition: background 0.12s; }\n    .show-season-header:hover { background: var(--bg); }\n    .show-season-poster { width: 32px; height: 48px; border-radius: 5px; object-fit: cover; background: var(--surface); flex-shrink: 0; }\n    .show-season-name { flex: 1; font-size: 0.9rem; font-weight: 700; color: #fff; }\n    .show-season-count { font-size: 0.72rem; color: var(--text-dim); }\n    .show-season-chevron { color: var(--text-mute); transition: transform 0.2s; font-size: 0.8rem; }\n    .show-season-card.open .show-season-chevron { transform: rotate(90deg); }\n    .show-season-body { display: none; border-top: 1px solid var(--border); padding: 14px 16px; }\n    .show-season-card.open .show-season-body { display: block; }\n    .ep-list { list-style: none; min-height: 40px; }\n    .ep-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; margin-bottom: 5px; background: var(--surface); border: 1px solid var(--border); cursor: grab; user-select: none; }\n    .ep-item.dragging { opacity: 0.45; background: var(--bg); }\n    .ep-item.drag-over { border-color: var(--accent); }\n    .ep-rank { width: 22px; text-align: center; flex-shrink: 0; font-size: 0.72rem; color: var(--text-mute); font-family: \"DM Mono\", monospace; }\n    .ep-drag { color: var(--text-mute); flex-shrink: 0; }\n    .ep-thumb { width: 56px; height: 32px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: var(--bg); }\n    .ep-info { flex: 1; min-width: 0; }\n    .ep-label { font-size: 0.8rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n    .ep-sublabel { font-size: 0.68rem; color: var(--text-dim); margin-top: 2px; }\n    .ep-rating { font-size: 0.72rem; color: var(--gold); font-family: \"DM Mono\", monospace; flex-shrink: 0; }\n    .ep-del { flex-shrink: 0; color: var(--text-mute); cursor: pointer; font-size: 1rem; padding: 4px; border-radius: 5px; transition: color 0.12s; }\n    .ep-del:hover { color: var(--danger); }\n    .ep-list-actions { display: flex; gap: 8px; margin-top: 10px; }\n    .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 500; align-items: center; justify-content: center; padding: 1.5rem; }\n    .modal-backdrop.open { display: flex; }\n    .modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 20px; max-width: 580px; width: 100%; max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; }\n    .modal-header { padding: 1.4rem 1.6rem 1rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 14px; }\n    .modal-poster { width: 36px; height: 54px; border-radius: 6px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }\n    .modal-title { font-size: 1rem; font-weight: 700; color: #fff; }\n    .modal-sub { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }\n    .modal-close { margin-left: auto; color: var(--text-mute); cursor: pointer; font-size: 1.3rem; }\n    .modal-close:hover { color: var(--text); }\n    .modal-filter { padding: 12px 1.6rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }\n    .season-filter-btn { padding: 5px 13px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; background: var(--surface2); border: 1.5px solid var(--border); color: var(--text-dim); cursor: pointer; transition: all 0.12s; }\n    .season-filter-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }\n    .modal-ep-list { flex: 1; overflow-y: auto; padding: 10px 1.6rem; }\n    .modal-ep-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; margin-bottom: 4px; cursor: pointer; transition: background 0.1s; border: 1.5px solid transparent; }\n    .modal-ep-item:hover { background: var(--surface2); }\n    .modal-ep-item.selected { border-color: var(--accent); }\n    .modal-ep-thumb { width: 64px; height: 36px; border-radius: 5px; object-fit: cover; background: var(--surface2); flex-shrink: 0; }\n    .modal-ep-info { flex: 1; min-width: 0; }\n    .modal-ep-name { font-size: 0.82rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n    .modal-ep-meta { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; }\n    .modal-ep-check { width: 20px; height: 20px; border-radius: 6px; border: 2px solid var(--border2); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; transition: all 0.12s; }\n    .modal-ep-item.selected .modal-ep-check { background: var(--accent); border-color: var(--accent); color: #fff; }\n    .modal-footer { padding: 1rem 1.6rem; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 10px; }\n    .modal-selected-count { font-size: 0.8rem; color: var(--text-dim); }\n    .generate-hero { text-align: center; padding: 1.2rem 0 2rem; }\n    .generate-hero h2 { font-size: 1.3rem; font-weight: 700; color: #fff; margin-bottom: 6px; }\n    .generate-hero p { font-size: 0.83rem; color: var(--text-dim); }\n    .summary-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 10px; background: var(--surface2); border: 1px solid var(--border); margin-bottom: 8px; font-size: 0.82rem; }\n    .summary-label { color: var(--text-dim); }\n    .summary-value { color: #fff; font-weight: 600; font-family: \"DM Mono\", monospace; font-size: 0.78rem; }\n    .summary-value.accent { color: var(--accent); }\n    .summary-value.gold { color: var(--gold); }\n    .or-line { text-align: center; font-size: 0.72rem; color: var(--text-mute); margin: 14px 0 12px; }\n    .copy-row { display: flex; gap: 8px; }\n    .copy-row input { flex: 1; font-size: 0.73rem; color: var(--text-dim); padding: 9px 12px; font-family: \"DM Mono\", monospace; }\n    .btn-copy { flex-shrink: 0; padding: 9px 16px; background: var(--surface2); border: 1.5px solid var(--border2); border-radius: var(--radius); color: var(--text-dim); font-size: 0.78rem; font-weight: 600; cursor: pointer; transition: all 0.15s; font-family: inherit; }\n    .btn-copy:hover { border-color: var(--accent); color: var(--accent); }\n    .btn-copy.copied { border-color: var(--accent2); color: var(--accent2); }\n    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.2); border-top-color: rgba(255,255,255,0.8); border-radius: 50%; animation: spin 0.7s linear infinite; }\n    @keyframes spin { to { transform: rotate(360deg); } }\n    .loading-overlay { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 2rem; font-size: 0.83rem; color: var(--text-dim); }\n    .nav-row { display: flex; justify-content: space-between; align-items: center; margin-top: 1.4rem; }\n    @media (max-width: 540px) { .features-grid { grid-template-columns: 1fr; } .main { padding: 1.5rem 1rem; } }\n  </style>\n</head>\n<body>\n<div class=\"app\">\n  <div class=\"topbar\">\n    <div class=\"topbar-logo\">&#127916; TMDB Best Of</div>\n    <div class=\"topbar-steps\">\n      <div class=\"step-item active\" id=\"step-tab-1\"><span class=\"step-num\">1</span><span>API Key</span></div>\n      <span class=\"step-divider\">&rsaquo;</span>\n      <div class=\"step-item\" id=\"step-tab-2\"><span class=\"step-num\">2</span><span>Custom Seasons</span></div>\n      <span class=\"step-divider\">&rsaquo;</span>\n      <div class=\"step-item\" id=\"step-tab-3\"><span class=\"step-num\">3</span><span>Install</span></div>\n    </div>\n  </div>\n  <div class=\"main\">\n\n    <div class=\"page active\" id=\"page-1\">\n      <div class=\"card\">\n        <div style=\"text-align:center;padding:1rem 0 1.8rem;font-size:4rem;opacity:0.6\">&#128273;</div>\n        <div class=\"card-title\">Connect to TMDB</div>\n        <div class=\"card-sub\">Enter your free TMDB API key to get started.</div>\n        <div class=\"features-grid\">\n          <div class=\"feature-chip\">&#127916; Movie metadata</div>\n          <div class=\"feature-chip\">&#128250; Series metadata</div>\n          <div class=\"feature-chip\">&#11088; Auto Best Of season</div>\n          <div class=\"feature-chip\">&#9999;&#65039; Custom episode lists</div>\n        </div>\n        <div class=\"field\">\n          <label>TMDB API Key (v3)</label>\n          <input type=\"password\" id=\"apiKey\" placeholder=\"Paste your API key here...\" autocomplete=\"off\" spellcheck=\"false\" onkeydown=\"if(event.key==='Enter') validateApiKey()\"/>\n          <p class=\"hint\">Free key from <a href=\"https://www.themoviedb.org/settings/api\" target=\"_blank\">themoviedb.org/settings/api</a></p>\n        </div>\n        <div class=\"field\">\n          <label>Default top episodes count</label>\n          <input type=\"number\" id=\"topN\" placeholder=\"20\" min=\"5\" max=\"100\"/>\n          <p class=\"hint\">For shows without a custom season, show the top N rated episodes. Default: 20.</p>\n        </div>\n        <button class=\"btn btn-primary btn-lg\" style=\"width:100%\" onclick=\"validateApiKey()\" id=\"btn-validate\">Continue &rarr;</button>\n      </div>\n    </div>\n\n    <div class=\"page\" id=\"page-2\">\n      <div class=\"card\">\n        <div class=\"card-title\">&#9999;&#65039; Custom Best Of Seasons</div>\n        <div class=\"card-sub\">Search for a show and hand-pick which episodes appear in its Best Of season in any order you like. Shows without a custom season fall back to auto top-rated.</div>\n        <div class=\"search-wrap field\">\n          <span class=\"search-icon\">&#128269;</span>\n          <input type=\"text\" id=\"series-search\" placeholder=\"Search for a TV show...\" oninput=\"debounceSearch(this.value)\" autocomplete=\"off\"/>\n        </div>\n        <div id=\"search-results\" class=\"search-results\"></div>\n      </div>\n      <div class=\"card\">\n        <div class=\"section-header\">\n          <span class=\"section-title\">Your custom seasons</span>\n          <span id=\"custom-count\" style=\"font-size:0.75rem;color:var(--text-dim)\"></span>\n        </div>\n        <div id=\"custom-seasons-list\">\n          <div class=\"custom-seasons-empty\">No custom seasons yet. Search for a show above to get started.</div>\n        </div>\n      </div>\n      <div class=\"nav-row\">\n        <button class=\"btn btn-secondary\" onclick=\"goTo(1)\">&larr; Back</button>\n        <button class=\"btn btn-gold btn-lg\" onclick=\"goTo(3)\">Generate Install Link &rarr;</button>\n      </div>\n    </div>\n\n    <div class=\"page\" id=\"page-3\">\n      <div class=\"card\">\n        <div class=\"generate-hero\">\n          <div style=\"font-size:3.5rem;margin-bottom:12px\">&#128640;</div>\n          <h2>Ready to install!</h2>\n          <p>Your addon is configured. Click below to add it directly to Stremio.</p>\n        </div>\n        <div id=\"install-summary\"></div>\n        <button class=\"btn btn-install\" onclick=\"openStremio()\">&#9889; Install in Stremio</button>\n        <div class=\"or-line\">-- or add manually --</div>\n        <div class=\"copy-row\">\n          <input type=\"text\" id=\"manifest-url\" readonly/>\n          <button class=\"btn-copy\" id=\"copy-btn\" onclick=\"copyUrl()\">Copy</button>\n        </div>\n      </div>\n      <div class=\"nav-row\">\n        <button class=\"btn btn-secondary\" onclick=\"goTo(2)\">&larr; Back</button>\n      </div>\n    </div>\n\n  </div>\n</div>\n\n<div class=\"modal-backdrop\" id=\"modal-backdrop\" onclick=\"closeModalOnBackdrop(event)\">\n  <div class=\"modal\">\n    <div class=\"modal-header\">\n      <img class=\"modal-poster\" id=\"modal-poster\" src=\"\" alt=\"\"/>\n      <div><div class=\"modal-title\" id=\"modal-show-name\">Loading...</div><div class=\"modal-sub\" id=\"modal-show-sub\"></div></div>\n      <div class=\"modal-close\" onclick=\"closeModal()\">x</div>\n    </div>\n    <div class=\"modal-filter\" id=\"modal-season-filters\"></div>\n    <div class=\"modal-ep-list\" id=\"modal-ep-list\">\n      <div class=\"loading-overlay\"><div class=\"spinner\"></div> Loading episodes...</div>\n    </div>\n    <div class=\"modal-footer\">\n      <span class=\"modal-selected-count\">Selected: <span id=\"modal-sel-count\">0</span></span>\n      <div style=\"display:flex;gap:8px\">\n        <button class=\"btn btn-secondary btn-sm\" onclick=\"closeModal()\">Cancel</button>\n        <button class=\"btn btn-primary btn-sm\" onclick=\"addSelectedEpisodes()\">Add to Season</button>\n      </div>\n    </div>\n  </div>\n</div>\n\n<script>\nvar state = { apiKey: \"\", topN: 20, customSeasons: {} };\nvar modalData = { tmdbId: null, tmdbName: null, tmdbPoster: null, allEpisodes: [], filteredSeason: \"all\", selected: new Set() };\n\nfunction goTo(n) {\n  document.querySelectorAll(\".page\").forEach(function(p, i) { p.classList.toggle(\"active\", i + 1 === n); });\n  document.querySelectorAll(\"[id^=step-tab-]\").forEach(function(el, i) {\n    var num = i + 1;\n    el.classList.remove(\"active\", \"done\");\n    if (num === n) el.classList.add(\"active\");\n    else if (num < n) el.classList.add(\"done\");\n  });\n  if (n === 3) buildInstallPage();\n  window.scrollTo({ top: 0, behavior: \"smooth\" });\n}\n\nasync function validateApiKey() {\n  var input = document.getElementById(\"apiKey\");\n  var key = input.value.trim();\n  var btn = document.getElementById(\"btn-validate\");\n  if (!key) { flashError(input); return; }\n  btn.innerHTML = \"<span class=\\\"spinner\\\"></span> Validating...\";\n  btn.disabled = true;\n  try {\n    var r = await fetch(\"/api/search?q=test&apiKey=\" + encodeURIComponent(key));\n    var d = await r.json();\n    if (d.error) throw new Error(d.error);\n    state.apiKey = key;\n    state.topN = parseInt(document.getElementById(\"topN\").value) || 20;\n    goTo(2);\n  } catch(e) {\n    flashError(input);\n    input.placeholder = \"Invalid API key - try again\";\n  } finally {\n    btn.innerHTML = \"Continue &rarr;\";\n    btn.disabled = false;\n  }\n}\n\nfunction flashError(el) { el.classList.add(\"error\"); el.focus(); setTimeout(function() { el.classList.remove(\"error\"); }, 2000); }\n\nvar searchTimer;\nfunction debounceSearch(q) {\n  clearTimeout(searchTimer);\n  if (!q.trim()) { document.getElementById(\"search-results\").classList.remove(\"visible\"); return; }\n  searchTimer = setTimeout(function() { doSearch(q); }, 350);\n}\n\nasync function doSearch(q) {\n  var box = document.getElementById(\"search-results\");\n  box.classList.add(\"visible\");\n  box.innerHTML = \"<div class=\\\"loading-overlay\\\"><div class=\\\"spinner\\\"></div> Searching...</div>\";\n  try {\n    var r = await fetch(\"/api/search?q=\" + encodeURIComponent(q) + \"&apiKey=\" + encodeURIComponent(state.apiKey));\n    var d = await r.json();\n    if (!d.results || !d.results.length) { box.innerHTML = \"<p style=\\\"padding:1rem;font-size:0.82rem;color:var(--text-mute)\\\">No results found.</p>\"; return; }\n    box.innerHTML = d.results.map(function(s) {\n      var posterHtml = s.poster\n        ? \"<img class=\\\"search-poster\\\" src=\\\"\" + s.poster + \"\\\" alt=\\\"\\\" loading=\\\"lazy\\\"/>\"\n        : \"<div class=\\\"search-poster\\\" style=\\\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\\\">&#128250;</div>\";\n      return \"<div class=\\\"search-result-item\\\" onclick=\\\"openModal(\" + s.id + \",\\\" + esc4attr(s.name) + \"\\\",\\\" + esc4attr(s.poster || \"\") + \"\\\")\\\">\" + posterHtml + \"<div><div class=\\\"search-name\\\">\" + esc(s.name) + \"</div><div class=\\\"search-meta\\\">\" + (s.year ? s.year + \" &middot; \" : \"\") + \"&#11088; \" + s.vote_average + \"</div></div></div>\";\n    }).join(\"\");\n  } catch(e) { box.innerHTML = \"<p style=\\\"padding:1rem;color:var(--text-mute)\\\">Error searching.</p>\"; }\n}\n\nasync function openModal(tmdbId, name, poster) {\n  modalData.tmdbId = tmdbId; modalData.tmdbName = name; modalData.tmdbPoster = poster;\n  modalData.allEpisodes = []; modalData.filteredSeason = \"all\";\n  var existing = (state.customSeasons[tmdbId] && state.customSeasons[tmdbId].episodes) || [];\n  modalData.selected = new Set(existing.map(function(e) { return e.season + \":\" + e.episode; }));\n  document.getElementById(\"modal-show-name\").textContent = name;\n  document.getElementById(\"modal-show-sub\").textContent = \"Loading...\";\n  document.getElementById(\"modal-poster\").src = poster || \"\";\n  document.getElementById(\"modal-season-filters\").innerHTML = \"\";\n  document.getElementById(\"modal-ep-list\").innerHTML = \"<div class=\\\"loading-overlay\\\"><div class=\\\"spinner\\\"></div> Loading episodes...</div>\";\n  updateModalCount();\n  document.getElementById(\"modal-backdrop\").classList.add(\"open\");\n  document.body.style.overflow = \"hidden\";\n  document.getElementById(\"search-results\").classList.remove(\"visible\");\n  document.getElementById(\"series-search\").value = \"\";\n  try {\n    var r = await fetch(\"/api/episodes?tmdbId=\" + tmdbId + \"&apiKey=\" + encodeURIComponent(state.apiKey));\n    var d = await r.json();\n    if (d.error) throw new Error(d.error);\n    modalData.allEpisodes = d.episodes;\n    document.getElementById(\"modal-show-sub\").textContent = d.show.seasons + \" season\" + (d.show.seasons !== 1 ? \"s\" : \"\") + \" - \" + d.episodes.length + \" episodes\";\n    var seasons = [];\n    d.episodes.forEach(function(e) { if (seasons.indexOf(e.season) === -1) seasons.push(e.season); });\n    seasons.sort(function(a,b) { return a-b; });\n    var filters = document.getElementById(\"modal-season-filters\");\n    var btns = [\"<button class=\\\"season-filter-btn active\\\" onclick=\\\"setSeasonFilter(\\'all\\',this)\\\">All</button>\"];\n    seasons.forEach(function(s) { btns.push(\"<button class=\\\"season-filter-btn\\\" onclick=\\\"setSeasonFilter(\" + s + \",this)\\\">S\" + s + \"</button>\"); });\n    filters.innerHTML = btns.join(\"\");\n    renderModalEpisodes();\n  } catch(e) {\n    document.getElementById(\"modal-ep-list\").innerHTML = \"<p style=\\\"padding:1rem;color:var(--text-mute)\\\">Error: \" + esc(e.message) + \"</p>\";\n  }\n}\n\nfunction setSeasonFilter(val, btn) {\n  modalData.filteredSeason = val;\n  document.querySelectorAll(\".season-filter-btn\").forEach(function(b) { b.classList.remove(\"active\"); });\n  btn.classList.add(\"active\");\n  renderModalEpisodes();\n}\n\nfunction renderModalEpisodes() {\n  var eps = modalData.filteredSeason === \"all\"\n    ? modalData.allEpisodes\n    : modalData.allEpisodes.filter(function(e) { return e.season === modalData.filteredSeason; });\n  var list = document.getElementById(\"modal-ep-list\");\n  if (!eps.length) { list.innerHTML = \"<p style=\\\"padding:1rem;color:var(--text-mute)\\\">No episodes.</p>\"; return; }\n  list.innerHTML = eps.map(function(ep) {\n    var key = ep.season + \":\" + ep.episode;\n    var sel = modalData.selected.has(key);\n    var sLabel = String(ep.season).padStart(2,\"0\");\n    var eLabel = String(ep.episode).padStart(2,\"0\");\n    var thumbHtml = ep.still\n      ? \"<img class=\\\"modal-ep-thumb\\\" src=\\\"\" + ep.still + \"\\\" alt=\\\"\\\" loading=\\\"lazy\\\"/>\"\n      : \"<div class=\\\"modal-ep-thumb\\\" style=\\\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\\\">&#127902;</div>\";\n    return \"<div class=\\\"modal-ep-item \" + (sel ? \"selected\" : \"\") + \"\\\" onclick=\\\"toggleEp('\" + key + \"',this)\\\">\" + thumbHtml + \"<div class=\\\"modal-ep-info\\\"><div class=\\\"modal-ep-name\\\">S\" + sLabel + \"E\" + eLabel + \" - \" + esc(ep.name) + \"</div><div class=\\\"modal-ep-meta\\\">\" + (ep.vote_average > 0 ? \"&#11088; \" + ep.vote_average.toFixed(1) + \" &middot; \" : \"\") + (ep.air_date || \"\") + \"</div></div><div class=\\\"modal-ep-check\\\">\" + (sel ? \"&#10003;\" : \"\") + \"</div></div>\";\n  }).join(\"\");\n}\n\nfunction toggleEp(key, el) {\n  if (modalData.selected.has(key)) {\n    modalData.selected.delete(key);\n    el.classList.remove(\"selected\");\n    el.querySelector(\".modal-ep-check\").innerHTML = \"\";\n  } else {\n    modalData.selected.add(key);\n    el.classList.add(\"selected\");\n    el.querySelector(\".modal-ep-check\").innerHTML = \"&#10003;\";\n  }\n  updateModalCount();\n}\n\nfunction updateModalCount() { document.getElementById(\"modal-sel-count\").textContent = modalData.selected.size; }\n\nfunction addSelectedEpisodes() {\n  var keys = Array.from(modalData.selected);\n  var episodes = keys.map(function(k) {\n    var parts = k.split(\":\").map(Number);\n    return modalData.allEpisodes.find(function(ep) { return ep.season === parts[0] && ep.episode === parts[1]; });\n  }).filter(Boolean);\n  var existing = (state.customSeasons[modalData.tmdbId] && state.customSeasons[modalData.tmdbId].episodes) || [];\n  var existingKeys = new Set(existing.map(function(e) { return e.season + \":\" + e.episode; }));\n  var newEps = episodes.filter(function(e) { return !existingKeys.has(e.season + \":\" + e.episode); });\n  var kept = existing.filter(function(e) { return keys.indexOf(e.season + \":\" + e.episode) !== -1; });\n  var merged = kept.concat(newEps);\n  if (merged.length === 0) { delete state.customSeasons[modalData.tmdbId]; }\n  else {\n    state.customSeasons[modalData.tmdbId] = { name: modalData.tmdbName, poster: modalData.tmdbPoster, tmdbId: modalData.tmdbId, episodes: merged };\n  }\n  closeModal();\n  renderCustomSeasonsList();\n}\n\nfunction closeModal() { document.getElementById(\"modal-backdrop\").classList.remove(\"open\"); document.body.style.overflow = \"\"; }\nfunction closeModalOnBackdrop(e) { if (e.target === document.getElementById(\"modal-backdrop\")) closeModal(); }\n\nfunction renderCustomSeasonsList() {\n  var el = document.getElementById(\"custom-seasons-list\");\n  var cnt = document.getElementById(\"custom-count\");\n  var ids = Object.keys(state.customSeasons);\n  cnt.textContent = ids.length ? ids.length + \" show\" + (ids.length > 1 ? \"s\" : \"\") : \"\";\n  if (!ids.length) { el.innerHTML = \"<div class=\\\"custom-seasons-empty\\\">No custom seasons yet. Search for a show above to get started.</div>\"; return; }\n  el.innerHTML = ids.map(function(tid) {\n    var show = state.customSeasons[tid];\n    var posterHtml = show.poster\n      ? \"<img class=\\\"show-season-poster\\\" src=\\\"\" + show.poster + \"\\\" alt=\\\"\\\" loading=\\\"lazy\\\"/>\"\n      : \"<div class=\\\"show-season-poster\\\" style=\\\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\\\">&#128250;</div>\";\n    var epItems = show.episodes.map(function(ep, i) {\n      var sLabel = String(ep.season).padStart(2,\"0\");\n      var eLabel = String(ep.episode).padStart(2,\"0\");\n      var thumbHtml = ep.still\n        ? \"<img class=\\\"ep-thumb\\\" src=\\\"\" + ep.still + \"\\\" alt=\\\"\\\" loading=\\\"lazy\\\"/>\"\n        : \"<div class=\\\"ep-thumb\\\" style=\\\"display:flex;align-items:center;justify-content:center;color:var(--text-mute)\\\">&#127902;</div>\";\n      return \"<li class=\\\"ep-item\\\" draggable=\\\"true\\\" data-tid=\\\"\" + tid + \"\\\" data-idx=\\\"\" + i + \"\\\">\" +\n        \"<span class=\\\"ep-rank\\\">\" + (i+1) + \"</span>\" +\n        \"<span class=\\\"ep-drag\\\">&#8943;</span>\" +\n        thumbHtml +\n        \"<div class=\\\"ep-info\\\"><div class=\\\"ep-label\\\">S\" + sLabel + \"E\" + eLabel + \" - \" + esc(ep.name) + \"</div><div class=\\\"ep-sublabel\\\">\" + (ep.air_date || \"\") + \"</div></div>\" +\n        (ep.vote_average > 0 ? \"<span class=\\\"ep-rating\\\">&#11088;\" + ep.vote_average.toFixed(1) + \"</span>\" : \"\") +\n        \"<span class=\\\"ep-del\\\" onclick=\\\"removeEp('\" + tid + \"',\" + i + \")\\\" title=\\\"Remove\\\">x</span>\" +\n        \"</li>\";\n    }).join(\"\");\n    return \"<div class=\\\"show-season-card\\\" id=\\\"card-\" + tid + \"\\\">\" +\n      \"<div class=\\\"show-season-header\\\" onclick=\\\"toggleCard('\" + tid + \"'\\)\\\">\" +\n      posterHtml +\n      \"<span class=\\\"show-season-name\\\">\" + esc(show.name) + \"</span>\" +\n      \"<span class=\\\"show-season-count\\\">\" + show.episodes.length + \" ep\" + (show.episodes.length !== 1 ? \"s\" : \"\") + \"</span>\" +\n      \"<span class=\\\"show-season-chevron\\\">&rsaquo;</span></div>\" +\n      \"<div class=\\\"show-season-body\\\"><ul class=\\\"ep-list\\\" id=\\\"eplist-\" + tid + \"\\\" data-tid=\\\"\" + tid + \"\\\">\" + epItems + \"</ul>\" +\n      \"<div class=\\\"ep-list-actions\\\">\" +\n      \"<button class=\\\"btn btn-secondary btn-sm\\\" onclick=\\\"openModal(\" + tid + \",\\\" + esc4attr(show.name) + \"\\\",\\\" + esc4attr(show.poster || \"\") + \"\\\")\\\">Edit Episodes</button>\" +\n      \"<button class=\\\"btn btn-danger btn-sm\\\" onclick=\\\"removeSeason('\" + tid + \"')\\\">Remove</button>\" +\n      \"</div></div></div>\";\n  }).join(\"\");\n  ids.forEach(function(tid) { initDragSort(tid); });\n}\n\nfunction toggleCard(tid) { document.getElementById(\"card-\" + tid).classList.toggle(\"open\"); }\nfunction removeSeason(tid) { delete state.customSeasons[tid]; renderCustomSeasonsList(); }\nfunction removeEp(tid, idx) { state.customSeasons[tid].episodes.splice(idx, 1); if (!state.customSeasons[tid].episodes.length) delete state.customSeasons[tid]; renderCustomSeasonsList(); }\n\nfunction initDragSort(tid) {\n  var list = document.getElementById(\"eplist-\" + tid);\n  if (!list) return;\n  var dragIdx = null;\n  list.querySelectorAll(\".ep-item\").forEach(function(item, idx) {\n    item.addEventListener(\"dragstart\", function(e) { dragIdx = idx; item.classList.add(\"dragging\"); e.dataTransfer.effectAllowed = \"move\"; });\n    item.addEventListener(\"dragend\", function() { item.classList.remove(\"dragging\"); });\n    item.addEventListener(\"dragover\", function(e) { e.preventDefault(); list.querySelectorAll(\".ep-item\").forEach(function(i) { i.classList.remove(\"drag-over\"); }); item.classList.add(\"drag-over\"); });\n    item.addEventListener(\"dragleave\", function() { item.classList.remove(\"drag-over\"); });\n    item.addEventListener(\"drop\", function(e) {\n      e.preventDefault(); item.classList.remove(\"drag-over\");\n      var dropIdx = parseInt(item.dataset.idx);\n      if (dragIdx === null || dragIdx === dropIdx) return;\n      var eps = state.customSeasons[tid].episodes;\n      var moved = eps.splice(dragIdx, 1)[0];\n      eps.splice(dropIdx, 0, moved);\n      renderCustomSeasonsList();\n      var card = document.getElementById(\"card-\" + tid);\n      if (card) card.classList.add(\"open\");\n    });\n  });\n}\n\nfunction buildInstallPage() {\n  var customSeasonsFlat = {};\n  Object.keys(state.customSeasons).forEach(function(tid) {\n    customSeasonsFlat[tid] = state.customSeasons[tid].episodes.map(function(e) { return { season: e.season, episode: e.episode }; });\n  });\n  var cfg = { tmdbApiKey: state.apiKey, topN: state.topN, customSeasons: customSeasonsFlat };\n  var encoded = btoa(JSON.stringify(cfg));\n  var base = window.location.origin;\n  var manifestUrl = base + \"/\" + encoded + \"/manifest.json\";\n  document.getElementById(\"manifest-url\").value = manifestUrl;\n  var showCount = Object.keys(state.customSeasons).length;\n  document.getElementById(\"install-summary\").innerHTML =\n    \"<div class=\\\"summary-row\\\"><span class=\\\"summary-label\\\">Custom seasons</span><span class=\\\"summary-value \" + (showCount > 0 ? \"gold\" : \"\") + \"\\\">\" + (showCount > 0 ? showCount + \" show\" + (showCount !== 1 ? \"s\" : \"\") : \"None (auto-ranked)\") + \"</span></div>\" +\n    \"<div class=\\\"summary-row\\\" style=\\\"margin-bottom:1.4rem\\\"><span class=\\\"summary-label\\\">Default top N</span><span class=\\\"summary-value accent\\\">\" + state.topN + \" episodes</span></div>\";\n}\n\nfunction openStremio() { var url = document.getElementById(\"manifest-url\").value; if (!url) return; window.location.href = url.replace(/^https?:\\/\\//, \"stremio://\"); }\n\nfunction copyUrl() {\n  var input = document.getElementById(\"manifest-url\");\n  input.select();\n  try { document.execCommand(\"copy\"); } catch(e) { navigator.clipboard && navigator.clipboard.writeText(input.value); }\n  var btn = document.getElementById(\"copy-btn\");\n  btn.textContent = \"Copied!\"; btn.classList.add(\"copied\");\n  setTimeout(function() { btn.textContent = \"Copy\"; btn.classList.remove(\"copied\"); }, 2000);\n}\n\nfunction esc(s) { return String(s || \"\").replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/>/g,\"&gt;\").replace(/\"/g,\"&quot;\"); }\nfunction esc4attr(s) { return String(s || \"\").replace(/\\\\/g,\"\\\\\\\\\").replace(/\"/g,\"&quot;\").replace(/'/g,\"\\'\"); }\n</script>\n</body>\n</html>";
}

const PORT = process.env.PORT || 7000;
app.listen(PORT, function() {
  console.log('TMDB Best Of addon running on port ' + PORT);
  console.log('Configure page: http://localhost:' + PORT + '/configure');
});