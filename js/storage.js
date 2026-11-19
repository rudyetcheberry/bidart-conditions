const PREFIX = 'bidart-conditions.';

export const DEFAULT_POINT = { lat: 43.4333, lng: -1.5833 };

export const DEFAULT_CRITERIA = {
  swellMin: 0.8,
  swellMax: 3.0,
  periodMin: 8,
  windMax: 20,
  windDirs: ['any'],
  tideLeadMin: 0,
  tideStates: ['high', 'low'],
  // Moments de marée favorables : 'rising' (montante), 'falling' (descendante),
  // 'mid' (mi-marée). Tableau vide = pas de contrainte.
  tidePhases: [],
  // Plage de coefficient de marée (0–120 = pas de contrainte).
  coefMin: 0,
  coefMax: 120,
};

export const DEFAULT_SPOTS = [
  { id: 'bidart', name: 'Bidart — Plage Centrale', lat: 43.4333, lng: -1.5833 },
  { id: 'ilbarritz', name: 'Bidart — Ilbarritz', lat: 43.4276, lng: -1.5747 },
  { id: 'pavillon', name: 'Bidart — Pavillon Royal', lat: 43.4204, lng: -1.5672 },
  { id: 'guethary', name: 'Guéthary — Parlementia', lat: 43.4246, lng: -1.5620 },
  { id: 'biarritz', name: 'Biarritz — Grande Plage', lat: 43.4832, lng: -1.5586 },
];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  demoMode: false,
  dailyQuota: 10,
  metarRelay: '',
  theme: 'dark', // 'dark' (nuit) ou 'light' (clair)
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}

export const Storage = {
  getSettings: () => ({ ...DEFAULT_SETTINGS, ...read('settings', {}) }),
  saveSettings: (settings) => write('settings', settings),

  getSpots: () => {
    const saved = read('spots', null);
    if (saved && Array.isArray(saved) && saved.length > 0) {
      // Migration : ne ré-ajouter que les spots par défaut jamais supprimés
      // volontairement par l'utilisateur (sinon la suppression était annulée
      // à chaque démarrage).
      const removed = read('removedSpots', []);
      const missing = DEFAULT_SPOTS.filter((d) => !saved.some((s) => s.id === d.id)
        && removed.indexOf(d.id) === -1);
      const merged = missing.length
        ? saved.concat(missing.map((d) => ({ ...d, config: { ...DEFAULT_CRITERIA } })))
        : saved;
      if (missing.length) write('spots', merged);
      return merged.map((s) => ({ ...s, config: { ...DEFAULT_CRITERIA, ...s.config } }));
    }
    // Migration : anciens critères uniques → spot par défaut
    const legacyAlerts = read('alerts', {});
    const legacySettings = read('settings', {});
    const point = legacySettings.point || DEFAULT_POINT;
    const spots = DEFAULT_SPOTS.map((s, i) => ({
      ...s,
      lat: i === 0 ? point.lat : s.lat,
      lng: i === 0 ? point.lng : s.lng,
      config: { ...DEFAULT_CRITERIA, ...legacyAlerts },
    }));
    return spots;
  },
  saveSpots: (spots) => write('spots', spots),

  getLastData: (spotId) => read('lastData.' + spotId, null),
  saveLastData: (spotId, data) => write('lastData.' + spotId, data),

  getTides: () => read('tides', null),
  saveTides: (tides) => write('tides', tides),

  getMetar: () => read('metar', null),
  saveMetar: (metar) => write('metar', metar),

  getUsage: () => {
    const u = read('usage', { date: '', count: 0 });
    const today = new Date().toISOString().slice(0, 10);
    return u.date === today ? u : { date: today, count: 0 };
  },
  saveUsage: (usage) => write('usage', usage),

  getSessions: () => read('sessions', []),
  saveSessions: (sessions) => write('sessions', sessions),

  // Spots par défaut supprimés volontairement (pour ne pas les ré-ajouter)
  getRemovedSpots: () => read('removedSpots', []),
  saveRemovedSpots: (ids) => write('removedSpots', ids),
};
