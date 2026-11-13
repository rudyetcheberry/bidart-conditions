const PREFIX = 'bidart-conditions.';

export const DEFAULT_POINT = { lat: 43.4333, lng: -1.5833 };

export const DEFAULT_ALERT_CONFIG = {
  swellMin: 0.8,
  swellMax: 3.0,
  periodMin: 8,
  windMax: 20,
  windDirs: ['any'],
  tideLeadMin: 0,
  tideStates: ['high', 'low'],
};

export const DEFAULT_SETTINGS = {
  apiKey: '',
  demoMode: true,
  point: DEFAULT_POINT,
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
  getAlertConfig: () => ({ ...DEFAULT_ALERT_CONFIG, ...read('alerts', {}) }),
  saveAlertConfig: (config) => write('alerts', config),
  getLastData: () => read('lastData', null),
  saveLastData: (data) => write('lastData', data),
  getUsage: () => {
    const u = read('usage', { date: '', count: 0 });
    const today = new Date().toISOString().slice(0, 10);
    return u.date === today ? u : { date: today, count: 0 };
  },
  saveUsage: (usage) => write('usage', usage),
};
