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
};

export const DEFAULT_SPOTS = [
  { id: 'bidart', name: 'Bidart — Plage Centrale', lat: 43.4333, lng: -1.5833 },
  { id: 'ilbarritz', name: 'Bidart — Ilbarritz', lat: 43.4276, lng: -1.5747 },
  { id: 'pavillon', name: 'Bidart — Pavillon Royal', lat: 43.4204, lng: -1.5672 },
  { id: 'guethary', name: 'Guéthary — Parlementia', lat: 43.4246, lng: -1.5620 },
];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  demoMode: false,
  dailyQuota: 10,
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
      return saved.map((s) => ({ ...s, config: { ...DEFAULT_CRITERIA, ...s.config } }));
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

  getActiveSpotId: () => read('activeSpotId', 'bidart'),
  saveActiveSpotId: (id) => write('activeSpotId', id),

  getLastData: (spotId) => read('lastData.' + spotId, null),
  saveLastData: (spotId, data) => write('lastData.' + spotId, data),

  getTides: () => read('tides', null),
  saveTides: (tides) => write('tides', tides),

  getUsage: () => {
    const u = read('usage', { date: '', count: 0 });
    const today = new Date().toISOString().slice(0, 10);
    return u.date === today ? u : { date: today, count: 0 };
  },
  saveUsage: (usage) => write('usage', usage),
};
