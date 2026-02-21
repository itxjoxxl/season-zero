const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ─── CORS (required for Stremio) ────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseConfig(configStr) {
  try {
    return JSON.parse(Buffer.from(configStr, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

// Fetch TMDB series details
async function getTmdbSeries(tmdbId, apiKey) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}&language=en-US`;
  const { data } = await axios.get(url);
  return data;
}

// Fetch all episodes of a series from TMDB
async function getAllEpisodes(tmdbId, apiKey, totalSeasons) {
  const episodes = [];
  for (let s = 1; s <= totalSeasons; s++) {
    try {
      const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${s}?api_key=${apiKey}&language=en-US`;
      const { data } = await axios.get(url);
      if (data.episodes) {
        for (const ep of data.episodes) {
          episodes.push({
            tmdbId,
            season: s,
            episode: ep.episode_number,
            name: ep.name,
            overview: ep.overview,
            still: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : null,
            vote_average: ep.vote_average || 0,
            vote_count: ep.vote_count || 0,
            air_date: ep.air_date,
          });
        }
      }
    } catch (e) {
      // skip missing seasons
    }
  }
  return episodes;
}

// IMDB lookup via TMDB external IDs
async function getImdbId(tmdbId, apiKey) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${apiKey}`;
  const { data } = await axios.get(url);
  return data.imdb_id || null;
}

// TMDB also stores episode vote averages. We use that as our "IMDB-style" rating
// since the TMDB /episode endpoint uses TMDB community votes (which closely mirrors IMDb).
async function getTopEpisodes(tmdbId, apiKey, totalSeasons, topN = 20) {
  const all = await getAllEpisodes(tmdbId, apiKey, totalSeasons);
  // Filter episodes with enough votes for reliability
  const filtered = all.filter(e => e.vote_count >= 5);
  filtered.sort((a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count);
  return filtered.slice(0, topN);
}

// ─── Manifest (static) ───────────────────────────────────────────────────────
// The configure page injects TMDB API key into the config path segment

app.get('/manifest.json', (req, res) => {
  res.json(buildManifest());
});

app.get('/:config/manifest.json', (req, res) => {
  res.json(buildManifest(req.params.config));
});

function buildManifest(config) {
  const cfg = config ? parseConfig(config) : {};
  return {
    id: 'community.tmdb-best-of',
    version: '1.0.0',
    name: 'TMDB Best Of',
    description: 'Adds a "Best Of" season to any series using top-rated episode data.',
    logo: 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg',
    catalogs: [],
    resources: ['meta', 'episodeVideos'],
    types: ['series'],
    idPrefixes: ['tmdb:'],
    behaviorHints: {
      configurable: true,
      configurationRequired: !cfg.tmdbApiKey,
    },
    config: [
      {
        key: 'tmdbApiKey',
        type: 'text',
        title: 'TMDB API Key',
        required: true,
      },
      {
        key: 'topN',
        type: 'number',
        title: 'Number of Top Episodes to show (default: 20)',
        required: false,
      },
    ],
  };
}

// ─── Configure Page ──────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.get('/configure', (req, res) => {
  res.send(configurePage());
});

// ─── Meta Handler ────────────────────────────────────────────────────────────
// Stremio sends tmdb:<id> as the series ID when using TMDB catalog addons.
// We intercept, enrich, and inject a virtual "Best Of (S00)" season.

app.get('/:config/meta/series/:id.json', async (req, res) => {
  const { config, id } = req.params;
  const cfg = parseConfig(config);
  if (!cfg.tmdbApiKey) return res.status(400).json({ err: 'No API key configured' });

  // Only handle tmdb: prefixed IDs
  if (!id.startsWith('tmdb:')) return res.json({ meta: null });

  const tmdbId = id.replace('tmdb:', '');
  const topN = parseInt(cfg.topN) || 20;

  try {
    const series = await getTmdbSeries(tmdbId, cfg.tmdbApiKey);

    const videos = [];

    // Regular seasons
    for (let s = 1; s <= (series.number_of_seasons || 0); s++) {
      try {
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${s}?api_key=${cfg.tmdbApiKey}&language=en-US`;
        const { data: season } = await axios.get(url);
        if (season.episodes) {
          for (const ep of season.episodes) {
            videos.push({
              id: `${id}:${s}:${ep.episode_number}`,
              title: ep.name || `Episode ${ep.episode_number}`,
              season: s,
              episode: ep.episode_number,
              overview: ep.overview,
              thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : null,
              released: ep.air_date ? new Date(ep.air_date) : null,
            });
          }
        }
      } catch {}
    }

    // Inject virtual "Best Of" season as Season 0
    const topEpisodes = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN);
    topEpisodes.forEach((ep, i) => {
      videos.push({
        id: `${id}:0:${i + 1}`,
        title: `#${i + 1} — S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} — ${ep.name}`,
        season: 0,
        episode: i + 1,
        overview: `⭐ ${ep.vote_average.toFixed(1)} (${ep.vote_count} votes)\n\n${ep.overview || ''}`,
        thumbnail: ep.still || null,
        released: ep.air_date ? new Date(ep.air_date) : null,
      });
    });

    const poster = series.poster_path
      ? `https://image.tmdb.org/t/p/w500${series.poster_path}`
      : null;
    const backdrop = series.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${series.backdrop_path}`
      : null;

    const meta = {
      id,
      type: 'series',
      name: series.name,
      poster,
      background: backdrop,
      logo: null,
      description: series.overview,
      releaseInfo: series.first_air_date ? series.first_air_date.substring(0, 4) : '',
      runtime: series.episode_run_time?.[0] ? `${series.episode_run_time[0]} min` : null,
      genres: series.genres?.map(g => g.name) || [],
      videos,
    };

    res.json({ meta });
  } catch (e) {
    console.error('Meta error:', e.message);
    res.status(500).json({ err: e.message });
  }
});

// ─── Episode Videos Handler ──────────────────────────────────────────────────
// When user clicks an episode in the Best Of season, map it back to the real episode ID

app.get('/:config/episodeVideos/series/:id.json', async (req, res) => {
  // id format: tmdb:12345:0:3  (season 0, episode 3 = 3rd top episode)
  const { config, id } = req.params;
  const cfg = parseConfig(config);
  if (!cfg.tmdbApiKey) return res.json({ videos: [] });

  const parts = id.split(':');
  // Expect tmdb:<tmdbId>:<season>:<episode>
  if (parts.length < 4 || parts[0] !== 'tmdb') return res.json({ videos: [] });

  const tmdbId = parts[1];
  const season = parseInt(parts[2]);
  const episodeNum = parseInt(parts[3]);
  const topN = parseInt(cfg.topN) || 20;

  // Only intercept the virtual Best Of season (season 0)
  if (season !== 0) return res.json({ videos: [] });

  try {
    const series = await getTmdbSeries(tmdbId, cfg.tmdbApiKey);
    const topEpisodes = await getTopEpisodes(tmdbId, cfg.tmdbApiKey, series.number_of_seasons || 1, topN);

    const targetEp = topEpisodes[episodeNum - 1];
    if (!targetEp) return res.json({ videos: [] });

    // Return the real episode ID so Stremio can find stream sources
    const realId = `tmdb:${tmdbId}:${targetEp.season}:${targetEp.episode}`;
    res.json({
      videos: [
        {
          id: realId,
          title: targetEp.name,
          season: targetEp.season,
          episode: targetEp.episode,
          thumbnail: targetEp.still,
          overview: targetEp.overview,
        },
      ],
    });
  } catch (e) {
    console.error('episodeVideos error:', e.message);
    res.json({ videos: [] });
  }
});

// ─── Configure Page HTML ─────────────────────────────────────────────────────

function configurePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>TMDB Best Of — Configure</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f0f13;
      color: #e0e0e0;
      font-family: 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: #1a1a24;
      border: 1px solid #2e2e40;
      border-radius: 16px;
      padding: 2.5rem;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 1.8rem;
    }
    .logo-icon {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, #01b4e4, #90cea1);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
    }
    h1 { font-size: 1.4rem; font-weight: 700; color: #fff; }
    p.sub { font-size: 0.85rem; color: #888; margin-top: 2px; }
    .field { margin-bottom: 1.4rem; }
    label { display: block; font-size: 0.82rem; color: #aaa; margin-bottom: 6px; font-weight: 500; }
    input {
      width: 100%;
      background: #0f0f13;
      border: 1px solid #2e2e40;
      border-radius: 8px;
      padding: 10px 14px;
      color: #e0e0e0;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: #01b4e4; }
    .hint { font-size: 0.75rem; color: #666; margin-top: 5px; }
    .hint a { color: #01b4e4; text-decoration: none; }
    button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #01b4e4, #0d9ecf);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
      margin-top: 0.4rem;
    }
    button:hover { opacity: 0.9; }
    #install-link {
      display: none;
      margin-top: 1.4rem;
      text-align: center;
    }
    #install-link a {
      display: inline-block;
      background: #7b2fbe;
      color: #fff;
      padding: 10px 28px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.95rem;
    }
    .copy-row {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .copy-row input {
      flex: 1;
      font-size: 0.75rem;
      color: #888;
    }
    .copy-btn {
      width: auto;
      padding: 10px 14px;
      font-size: 0.8rem;
      margin: 0;
      background: #2e2e40;
    }
    .section-title {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #666;
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid #2e2e40;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">⭐</div>
      <div>
        <h1>TMDB Best Of</h1>
        <p class="sub">Stremio Metadata Addon</p>
      </div>
    </div>

    <p style="font-size:0.88rem;color:#aaa;margin-bottom:1.8rem;line-height:1.6">
      Adds a virtual <strong style="color:#fff">Season 0 — Best Of</strong> to every series, 
      showing the top-rated episodes ranked by community votes.
    </p>

    <div class="field">
      <div class="section-title">Required</div>
      <label for="apiKey">TMDB API Key</label>
      <input type="text" id="apiKey" placeholder="e.g. a1b2c3d4e5f6..." />
      <p class="hint">Get a free key at <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a></p>
    </div>

    <div class="field">
      <div class="section-title">Optional</div>
      <label for="topN">Number of top episodes to include</label>
      <input type="number" id="topN" placeholder="20" min="5" max="100" />
      <p class="hint">Default is 20. Max recommended: 50.</p>
    </div>

    <button onclick="generate()">Generate Install Link</button>

    <div id="install-link">
      <a id="stremio-btn" href="#">Install in Stremio</a>
      <p style="font-size:0.75rem;color:#666;margin-top:8px">or copy the manifest URL to add manually:</p>
      <div class="copy-row">
        <input type="text" id="manifest-url" readonly />
        <button class="copy-btn" onclick="copyUrl()">Copy</button>
      </div>
    </div>
  </div>

  <script>
    function generate() {
      const apiKey = document.getElementById('apiKey').value.trim();
      const topN = document.getElementById('topN').value.trim();

      if (!apiKey) {
        alert('Please enter your TMDB API key.');
        return;
      }

      const cfg = { tmdbApiKey: apiKey };
      if (topN) cfg.topN = parseInt(topN);

      const encoded = btoa(JSON.stringify(cfg));
      const base = window.location.origin;
      const manifestUrl = \`\${base}/\${encoded}/manifest.json\`;
      const stremioUrl = manifestUrl.replace('https://', 'stremio://').replace('http://', 'stremio://');

      document.getElementById('manifest-url').value = manifestUrl;
      document.getElementById('stremio-btn').href = stremioUrl;
      document.getElementById('install-link').style.display = 'block';
    }

    function copyUrl() {
      const input = document.getElementById('manifest-url');
      input.select();
      document.execCommand('copy');
    }
  </script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`TMDB Best Of addon running on http://localhost:${PORT}`);
  console.log(`Configure: http://localhost:${PORT}/configure`);
});
