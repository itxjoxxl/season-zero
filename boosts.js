// ─── GOODTASTE BOOST GALLERY DATA ────────────────────────────────────────────
// Edit this file to add, remove, or update boost presets.
// Each boost can include defaultCatalogs (TMDB catalog IDs), customCatalogs,
// and customSeasons (best-of episode lists with pre-selected episodes).

const BOOST_PRESETS = [
  {
    id: 'prestige-drama',
    name: 'Prestige Drama',
    description: 'The greatest dramatic television ever made — handpicked episodes from the shows that redefined the medium.',
    emoji: '🎭',
    catalogCount: 2,
    listCount: 3,
    // TMDB catalog IDs to enable
    enableCatalogs: ['tmdb.top_rated_series', 'tmdb.trending_series'],
    // Custom TMDB Discover catalogs to add
    customCatalogs: [
      {
        name: 'Emmy Drama Winners',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '200', with_genres: '18' },
      },
    ],
    // Best-of episode lists
    customSeasons: [
      {
        tmdbId: '1396', // Breaking Bad
        label: 'Best Of',
        prefix: '✦',
        episodes: [
          { season: 4, episode: 13 }, // Face Off
          { season: 3, episode: 10 }, // Fly
          { season: 4, episode: 11 }, // Crawl Space
          { season: 5, episode: 14 }, // Ozymandias
          { season: 2, episode: 6  }, // Peekaboo
        ],
      },
      {
        tmdbId: '1399', // Game of Thrones
        label: 'Best Of',
        prefix: '✦',
        episodes: [
          { season: 6, episode: 9 }, // Battle of the Bastards
          { season: 6, episode: 10 }, // The Winds of Winter
          { season: 3, episode: 9  }, // The Rains of Castamere
          { season: 4, episode: 8  }, // The Mountain and the Viper
          { season: 2, episode: 9  }, // Blackwater
        ],
      },
      {
        tmdbId: '46648', // Succession
        label: 'Best Of',
        prefix: '✦',
        episodes: [
          { season: 3, episode: 8 }, // Chiantishire
          { season: 4, episode: 3 }, // Connor's Wedding
          { season: 4, episode: 10 }, // With Open Eyes
          { season: 1, episode: 8 }, // Prague
        ],
      },
    ],
    // Preview TMDB IDs (posters fetched for gallery display)
    previewTmdbIds: [
      { id: '1396', type: 'tv' },
      { id: '1399', type: 'tv' },
      { id: '46648', type: 'tv' },
      { id: '60735', type: 'tv' }, // The Wire
    ],
  },

  {
    id: 'arthouse-cinema',
    name: 'Art House Cinema',
    description: 'Critically acclaimed films from visionary directors. Cinema that challenges, moves, and endures.',
    emoji: '🎬',
    catalogCount: 2,
    listCount: 0,
    enableCatalogs: ['tmdb.top_rated_movies'],
    customCatalogs: [
      {
        name: 'A24 & Indie Greats',
        type: 'movie',
        path: '/discover/movie',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '500', 'vote_average.gte': '7.5', with_original_language: 'en' },
      },
      {
        name: 'International Cinema',
        type: 'movie',
        path: '/discover/movie',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '200', 'vote_average.gte': '7.8' },
      },
    ],
    customSeasons: [],
    previewTmdbIds: [
      { id: '238', type: 'movie' }, // Godfather
      { id: '680', type: 'movie' }, // Pulp Fiction
      { id: '496243', type: 'movie' }, // Parasite
      { id: '27205', type: 'movie' }, // Inception
    ],
  },

  {
    id: 'streaming-era',
    name: 'Streaming Era',
    description: 'The defining shows of the streaming era — genre-bending originals from Netflix, HBO, Apple TV+, and beyond.',
    emoji: '📺',
    catalogCount: 3,
    listCount: 3,
    enableCatalogs: ['tmdb.trending_series', 'tmdb.popular_series'],
    customCatalogs: [
      {
        name: 'Netflix Originals',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'popularity.desc', with_networks: '213' },
      },
      {
        name: 'HBO Max',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '100', with_networks: '49' },
      },
      {
        name: 'Apple TV+ Originals',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', with_networks: '2552' },
      },
    ],
    customSeasons: [
      {
        tmdbId: '95396', // Severance
        label: 'Best Of',
        prefix: '✦',
        episodes: [
          { season: 1, episode: 9 }, // The We We Are
          { season: 1, episode: 1 }, // Good News About Hell
          { season: 2, episode: 6 }, // Attila
          { season: 1, episode: 8 }, // What's for Dinner?
        ],
      },
      {
        tmdbId: '100088', // The Last of Us
        label: 'Best Of',
        prefix: '✦',
        episodes: [
          { season: 1, episode: 3 }, // Long, Long Time
          { season: 1, episode: 8 }, // When We Are in Need
          { season: 1, episode: 9 }, // Look for the Light
          { season: 1, episode: 5 }, // Endure and Survive
        ],
      },
      {
        tmdbId: '94605', // Squid Game
        label: 'Best Of',
        prefix: '✦',
        episodes: [
          { season: 1, episode: 6 }, // Gganbu
          { season: 1, episode: 1 }, // Red Light, Green Light
          { season: 1, episode: 9 }, // One Lucky Day
        ],
      },
    ],
    previewTmdbIds: [
      { id: '95396', type: 'tv' }, // Severance
      { id: '100088', type: 'tv' }, // The Last of Us
      { id: '94605', type: 'tv' }, // Squid Game
      { id: '90462', type: 'tv' }, // Chernobyl
    ],
  },

  {
    id: 'film-noir-thriller',
    name: 'Neo-Noir & Thriller',
    description: 'Psychological thrillers, crime epics, and neo-noir. Films and shows that keep you up at night.',
    emoji: '🕵️',
    catalogCount: 2,
    listCount: 2,
    enableCatalogs: ['tmdb.top_rated_movies', 'tmdb.top_rated_series'],
    customCatalogs: [
      {
        name: 'Crime Thrillers',
        type: 'movie',
        path: '/discover/movie',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '500', with_genres: '80,53' },
      },
      {
        name: 'Crime Drama Series',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '100', with_genres: '80,18' },
      },
    ],
    customSeasons: [
      {
        tmdbId: '60735', // The Wire
        label: 'Essential',
        prefix: '●',
        episodes: [
          { season: 3, episode: 11 }, // Middle Ground
          { season: 4, episode: 13 }, // Final Grades
          { season: 1, episode: 13 }, // Sentencing
          { season: 3, episode: 12 }, // Mission Accomplished
        ],
      },
      {
        tmdbId: '18347', // Better Call Saul
        label: 'Best Of',
        prefix: '●',
        episodes: [
          { season: 6, episode: 8 }, // Point and Shoot
          { season: 4, episode: 9 }, // Wiedersehen
          { season: 6, episode: 13 }, // Saul Gone
          { season: 5, episode: 9 }, // Bad Choice Road
        ],
      },
    ],
    previewTmdbIds: [
      { id: '60735', type: 'tv' }, // The Wire
      { id: '18347', type: 'tv' }, // Better Call Saul
      { id: '19995', type: 'movie' }, // No Country for Old Men (approx)
      { id: '680', type: 'movie' }, // Pulp Fiction
    ],
  },

  {
    id: 'comedy-legends',
    name: 'Comedy Legends',
    description: "The funniest, sharpest writing on TV. From workplace awkwardness to absurdist brilliance — television's comedy greats.",
    emoji: '😂',
    catalogCount: 1,
    listCount: 2,
    enableCatalogs: ['tmdb.popular_series'],
    customCatalogs: [
      {
        name: 'Top Comedies',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '200', with_genres: '35' },
      },
    ],
    customSeasons: [
      {
        tmdbId: '2316', // The Office (US)
        label: 'Best Of',
        prefix: '😂',
        episodes: [
          { season: 2, episode: 14 }, // The Injury
          { season: 5, episode: 12 }, // Stress Relief
          { season: 2, episode: 22 }, // Casino Night
          { season: 4, episode: 1  }, // Fun Run
          { season: 7, episode: 22 }, // Goodbye, Michael
        ],
      },
      {
        tmdbId: '46952', // Barry
        label: 'Best Of',
        prefix: '😂',
        episodes: [
          { season: 3, episode: 6 }, //710N
          { season: 1, episode: 6 }, // Listen with Your Ears, React with Your Face
          { season: 2, episode: 7 }, // The Audition
          { season: 4, episode: 8 }, // Wow
        ],
      },
    ],
    previewTmdbIds: [
      { id: '2316', type: 'tv' }, // The Office
      { id: '46952', type: 'tv' }, // Barry
      { id: '66732', type: 'tv' }, // Stranger Things
      { id: '1668', type: 'tv' }, // Friends
    ],
  },
];

module.exports = { BOOST_PRESETS };
