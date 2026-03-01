// ─── GOODTASTE BOOST GALLERY DATA ────────────────────────────────────────────
// Curated boost presets for Goodtaste.
// Each preset can enable default TMDB catalogs, add custom Discover catalogs,
// and add "Best Of" custom seasons (episode lists) for specific series.

const BOOST_PRESETS = [
  // 1) Sunday Night Prestige
  {
    id: 'sunday-night-prestige',
    name: 'Sunday Night Prestige',
    description: 'Big, serious, conversation-driving television. Power, consequence, and peak writing.',
    emoji: '🕯️',
    catalogCount: 2,
    listCount: 3,
    enableCatalogs: ['tmdb.top_rated_series', 'tmdb.trending_series'],
    customCatalogs: [
      {
        name: 'Critically Acclaimed Drama',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '200', with_genres: '18' },
      },
      {
        name: 'Prestige Drama Films',
        type: 'movie',
        path: '/discover/movie',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '500', with_genres: '18' },
      },
    ],
    customSeasons: [
      {
        tmdbId: '76331', // Succession
        label: 'Best Of',
        prefix: '🕯️',
        episodes: [
          { season: 2, episode: 10 }, // This Is Not for Tears
          { season: 2, episode: 3  }, // Hunting
          { season: 3, episode: 9  }, // All the Bells Say
          { season: 4, episode: 3  }, // Connor's Wedding
          { season: 4, episode: 10 }, // With Open Eyes
        ],
      },
      {
        tmdbId: '60059', // Better Call Saul
        label: 'Best Of',
        prefix: '🕯️',
        episodes: [
          { season: 3, episode: 5  }, // Chicanery
          { season: 5, episode: 8  }, // Bagman
          { season: 6, episode: 7  }, // Plan and Execution
          { season: 6, episode: 9  }, // Fun and Games
          { season: 6, episode: 13 }, // Saul Gone
        ],
      },
      {
        tmdbId: '1104', // Mad Men
        label: 'Best Of',
        prefix: '🕯️',
        episodes: [
          { season: 1, episode: 13 }, // The Wheel
          { season: 3, episode: 13 }, // Shut the Door. Have a Seat.
          { season: 4, episode: 7  }, // The Suitcase
          { season: 5, episode: 11 }, // The Other Woman
          { season: 7, episode: 14 }, // Person to Person
        ],
      },
    ],
    previewTmdbIds: [
      { id: '76331', type: 'tv' }, // Succession
      { id: '60059', type: 'tv' }, // Better Call Saul
      { id: '1104', type: 'tv' },  // Mad Men
      { id: '1396', type: 'tv' },  // Breaking Bad
    ],
  },

  // 2) Cozy Rewatch Classics
  {
    id: 'cozy-rewatch-classics',
    name: 'Cozy Rewatch Classics',
    description: 'Comfort TV only: warm, familiar, and endlessly rewatchable.',
    emoji: '🧸',
    catalogCount: 0,
    listCount: 3,
    enableCatalogs: [],
    customCatalogs: [
      {
        name: 'Feel-Good Comedies',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '150', with_genres: '35' },
      },
      {
        name: 'Comfort Watches (Comedy + Family)',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'popularity.desc', 'vote_count.gte': '100', with_genres: '35' },
      },
    ],
    customSeasons: [
      {
        tmdbId: '2316', // The Office (US)
        label: 'Essential',
        prefix: '🧸',
        episodes: [
          { season: 2, episode: 14 }, // The Injury
          { season: 5, episode: 12 }, // Stress Relief
          { season: 2, episode: 22 }, // Casino Night
          { season: 4, episode: 1  }, // Fun Run
          { season: 7, episode: 22 }, // Goodbye, Michael
        ],
      },
      {
        tmdbId: '8592', // Parks and Recreation
        label: 'Essential',
        prefix: '🧸',
        episodes: [
          { season: 2, episode: 23 }, // The Master Plan
          { season: 3, episode: 16 }, // Li'l Sebastian
          { season: 4, episode: 6  }, // End of the World
          { season: 5, episode: 13 }, // Emergency Response
          { season: 7, episode: 12 }, // One Last Ride
        ],
      },
      {
        tmdbId: '1421', // New Girl
        label: 'Essential',
        prefix: '🧸',
        episodes: [
          { season: 1, episode: 1  }, // Pilot
          { season: 2, episode: 25 }, // Elaine's Big Day
          { season: 3, episode: 14 }, // Prince
          { season: 4, episode: 6  }, // Background Check
          { season: 5, episode: 4  }, // No Girl
        ],
      },
    ],
    previewTmdbIds: [
      { id: '2316', type: 'tv' }, // The Office
      { id: '8592', type: 'tv' }, // Parks and Rec
      { id: '1421', type: 'tv' }, // New Girl
      { id: '1668', type: 'tv' }, // Friends
    ],
  },

  // 3) Smart Sci‑Fi
  {
    id: 'smart-sci-fi',
    name: 'Smart Sci‑Fi',
    description: 'High-concept, idea-forward sci‑fi — the kind that sticks with you.',
    emoji: '🧠',
    catalogCount: 1,
    listCount: 3,
    enableCatalogs: ['tmdb.top_rated_series'],
    customCatalogs: [
      {
        name: 'Sci‑Fi & Fantasy (Top Rated)',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '150', with_genres: '10765' },
      },
      {
        name: 'Sci‑Fi Movies (Top Rated)',
        type: 'movie',
        path: '/discover/movie',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '500', with_genres: '878' },
      },
    ],
    customSeasons: [
      {
        tmdbId: '42009', // Black Mirror
        label: 'Best Of',
        prefix: '🧠',
        episodes: [
          { season: 1, episode: 2 }, // 15 Million Merits
          { season: 2, episode: 4 }, // White Christmas
          { season: 3, episode: 1 }, // Nosedive
          { season: 3, episode: 4 }, // San Junipero
          { season: 4, episode: 1 }, // USS Callister
        ],
      },
      {
        tmdbId: '63247', // Westworld
        label: 'Best Of',
        prefix: '🧠',
        episodes: [
          { season: 1, episode: 1  }, // The Original
          { season: 1, episode: 7  }, // Trompe L'Oeil
          { season: 1, episode: 10 }, // The Bicameral Mind
          { season: 2, episode: 8  }, // Kiksuya
          { season: 3, episode: 8  }, // Crisis Theory
        ],
      },
      {
        tmdbId: '95396', // Severance
        label: 'Best Of',
        prefix: '🧠',
        episodes: [
          { season: 1, episode: 1  }, // Good News About Hell
          { season: 1, episode: 4  }, // The You You Are
          { season: 1, episode: 7  }, // Defiant Jazz
          { season: 1, episode: 9  }, // The We We Are
          { season: 1, episode: 10 }, // The Reckoning
        ],
      },
    ],
    previewTmdbIds: [
      { id: '95396', type: 'tv' }, // Severance
      { id: '42009', type: 'tv' }, // Black Mirror
      { id: '63247', type: 'tv' }, // Westworld
      { id: '603', type: 'movie' }, // The Matrix
    ],
  },

  // 4) Crime Stories That Escalate
  {
    id: 'crime-escalation',
    name: 'Crime Stories That Escalate',
    description: 'Slow build → spiral → consequences. No case-of-the-week, no filler.',
    emoji: '🧩',
    catalogCount: 1,
    listCount: 3,
    enableCatalogs: ['tmdb.top_rated_series'],
    customCatalogs: [
      {
        name: 'Crime Drama (Top Rated)',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '200', with_genres: '80,18' },
      },
      {
        name: 'Crime & Thriller Films',
        type: 'movie',
        path: '/discover/movie',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '800', with_genres: '80,53' },
      },
    ],
    customSeasons: [
      {
        tmdbId: '1396', // Breaking Bad
        label: 'Best Of',
        prefix: '🧩',
        episodes: [
          { season: 2, episode: 6  }, // Peekaboo
          { season: 3, episode: 10 }, // Fly
          { season: 4, episode: 11 }, // Crawl Space
          { season: 4, episode: 13 }, // Face Off
          { season: 5, episode: 14 }, // Ozymandias
        ],
      },
      {
        tmdbId: '1438', // The Wire
        label: 'Best Of',
        prefix: '🧩',
        episodes: [
          { season: 1, episode: 1  }, // The Target
          { season: 2, episode: 12 }, // Port in a Storm
          { season: 3, episode: 11 }, // Middle Ground
          { season: 4, episode: 13 }, // Final Grades
          { season: 5, episode: 10 }, // -30-
        ],
      },
      {
        tmdbId: '46648', // True Detective
        label: 'Best Of',
        prefix: '🧩',
        episodes: [
          { season: 1, episode: 1 }, // The Long Bright Dark
          { season: 1, episode: 4 }, // Who Goes There
          { season: 1, episode: 5 }, // The Secret Fate of All Life
          { season: 1, episode: 7 }, // After You've Gone
          { season: 1, episode: 8 }, // Form and Void
        ],
      },
    ],
    previewTmdbIds: [
      { id: '1396', type: 'tv' },  // Breaking Bad
      { id: '1438', type: 'tv' },  // The Wire
      { id: '46648', type: 'tv' }, // True Detective
      { id: '1399', type: 'tv' },  // Game of Thrones
    ],
  },

  // 5) Indie Film Night
  {
    id: 'indie-film-night',
    name: 'Indie Film Night',
    description: 'Festival energy, character-driven stories, and modern classics — no fake “studio” filters.',
    emoji: '🎞️',
    catalogCount: 1,
    listCount: 0,
    enableCatalogs: ['tmdb.top_rated_movies'],
    customCatalogs: [
      {
        name: 'Modern Indie‑Leaning Drama',
        type: 'movie',
        path: '/discover/movie',
        params: {
          sort_by: 'vote_average.desc',
          'vote_count.gte': '200',
          with_genres: '18',
          // Keep it “indie-ish” by avoiding the most blockbuster-y popularity
          'popularity.lte': '60',
        },
      },
      {
        name: 'International Standouts',
        type: 'movie',
        path: '/discover/movie',
        params: {
          sort_by: 'vote_average.desc',
          'vote_count.gte': '200',
          // Heavier tilt toward non-English without being too restrictive
          with_original_language: 'fr|es|it|ko|ja|de|pt',
        },
      },
    ],
    customSeasons: [],
    previewTmdbIds: [
      { id: '496243', type: 'movie' }, // Parasite
      { id: '550', type: 'movie' },    // Fight Club (classic, not indie but a known anchor)
      { id: '13', type: 'movie' },     // Forrest Gump (anchor)
      { id: '27205', type: 'movie' },  // Inception (anchor)
    ],
  },

  // 6) Prestige Limited Series
  {
    id: 'prestige-limited-series',
    name: 'Prestige Limited Series',
    description: 'One story, one season: 6–10 episodes of pure focus.',
    emoji: '📌',
    catalogCount: 1,
    listCount: 3,
    enableCatalogs: ['tmdb.trending_series'],
    customCatalogs: [
      {
        name: 'Mini‑Series & Limited Runs (Top Rated)',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '100', with_genres: '18' },
      },
    ],
    customSeasons: [
      {
        tmdbId: '87108', // Chernobyl
        label: 'Complete',
        prefix: '📌',
        episodes: [
          { season: 1, episode: 1 },
          { season: 1, episode: 2 },
          { season: 1, episode: 3 },
          { season: 1, episode: 4 },
          { season: 1, episode: 5 },
        ],
      },
      {
        tmdbId: '115004', // Mare of Easttown
        label: 'Complete',
        prefix: '📌',
        episodes: [
          { season: 1, episode: 1 },
          { season: 1, episode: 2 },
          { season: 1, episode: 3 },
          { season: 1, episode: 4 },
          { season: 1, episode: 5 },
          { season: 1, episode: 6 },
          { season: 1, episode: 7 },
        ],
      },
      {
        tmdbId: '87739', // The Queen's Gambit
        label: 'Complete',
        prefix: '📌',
        episodes: [
          { season: 1, episode: 1 },
          { season: 1, episode: 2 },
          { season: 1, episode: 3 },
          { season: 1, episode: 4 },
          { season: 1, episode: 5 },
          { season: 1, episode: 6 },
          { season: 1, episode: 7 },
        ],
      },
    ],
    previewTmdbIds: [
      { id: '87108', type: 'tv' },  // Chernobyl
      { id: '115004', type: 'tv' }, // Mare of Easttown
      { id: '87739', type: 'tv' },  // The Queen's Gambit
      { id: '100088', type: 'tv' }, // The Last of Us (anchor)
    ],
  },

  // 7) Action That Actually Hits
  {
    id: 'action-that-hits',
    name: 'Action That Actually Hits',
    description: 'Tight, kinetic, rewatchable action. Less sludge, more “hit play again.”',
    emoji: '⚡',
    catalogCount: 2,
    listCount: 0,
    enableCatalogs: ['tmdb.trending_movies', 'tmdb.popular_movies'],
    customCatalogs: [
      {
        name: 'Action Movies (Rewatchable)',
        type: 'movie',
        path: '/discover/movie',
        params: { sort_by: 'popularity.desc', 'vote_count.gte': '500', with_genres: '28' },
      },
      {
        name: 'Action & Adventure TV',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'popularity.desc', 'vote_count.gte': '150', with_genres: '10759' },
      },
    ],
    customSeasons: [],
    previewTmdbIds: [
      { id: '245891', type: 'movie' }, // John Wick
      { id: '603692', type: 'movie' }, // John Wick: Chapter 4
      { id: '562', type: 'movie' },    // Die Hard
      { id: '111', type: 'movie' },    // Scarface (anchor)
    ],
  },

  // 8) Dark Comedy & Satire
  {
    id: 'dark-comedy-satire',
    name: 'Dark Comedy & Satire',
    description: 'Sharp, cynical, elevated — laughs with teeth.',
    emoji: '🥂',
    catalogCount: 0,
    listCount: 3,
    enableCatalogs: [],
    customCatalogs: [
      {
        name: 'Dark Comedy (Comedy + Drama)',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '120', with_genres: '35,18' },
      },
      {
        name: 'Satire & Bite (Comedy + Crime)',
        type: 'series',
        path: '/discover/tv',
        params: { sort_by: 'vote_average.desc', 'vote_count.gte': '120', with_genres: '35,80' },
      },
    ],
    customSeasons: [
      {
        tmdbId: '61550', // Fleabag
        label: 'Essential',
        prefix: '🥂',
        episodes: [
          { season: 1, episode: 1 },
          { season: 1, episode: 4 },
          { season: 1, episode: 6 },
          { season: 2, episode: 1 },
          { season: 2, episode: 6 },
        ],
      },
      {
        tmdbId: '46952', // Barry (kept to match your existing file)
        label: 'Best Of',
        prefix: '🥂',
        episodes: [
          { season: 1, episode: 6 }, // Listen with Your Ears, React with Your Face
          { season: 2, episode: 5 }, // ronny/lily
          { season: 3, episode: 6 }, // 710N
          { season: 4, episode: 4 }, // it takes a psycho
          { season: 4, episode: 8 }, // wow
        ],
      },
      {
        tmdbId: '136315', // The Bear
        label: 'Pressure Cooker',
        prefix: '🥂',
        episodes: [
          { season: 1, episode: 7 }, // Review
          { season: 2, episode: 6 }, // Fishes
          { season: 2, episode: 7 }, // Forks
          { season: 2, episode: 10 }, // The Bear
        ],
      },
    ],
    previewTmdbIds: [
      { id: '61550', type: 'tv' },   // Fleabag
      { id: '46952', type: 'tv' },   // Barry
      { id: '136315', type: 'tv' },  // The Bear
      { id: '94605', type: 'tv' },   // The White Lotus (anchor)
    ],
  },
];

module.exports = { BOOST_PRESETS };
