import { Storage } from './storage.js';

const BASE = 'https://api.stormglass.io/v2';

const MARINE_PARAMS = [
  'windSpeed',
  'windDirection',
  'gust',
  'swellHeight',
  'swellPeriod',
  'swellDirection',
  'waterTemperature',
].join(',');

async function sgFetch(path, params) {
  const { apiKey } = Storage.getSettings();
  if (!apiKey) {
    throw new Error('Clé API Stormglass manquante (onglet Réglages).');
  }
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (res.status === 401) {
    throw new Error('Clé API refusée par Stormglass (401).');
  }
  if (res.status === 429) {
    throw new Error('Trop de requêtes, réessayez dans quelques minutes.');
  }
  if (res.status === 402) {
    throw new Error('Quota quotidien Stormglass épuisé (offre gratuite : 50 requêtes/jour). Réessayez demain.');
  }
  if (!res.ok) {
    throw new Error(`Erreur Stormglass ${res.status}`);
  }
  return res.json();
}

export async function fetchMarine({ lat, lng }, hours = 48) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  const data = await sgFetch('/weather/point', {
    lat,
    lng,
    params: MARINE_PARAMS,
    start: now.toISOString(),
    end: end.toISOString(),
  });
  return data.hours.map((h) => ({
    time: new Date(h.time),
    windSpeed: kph(h.windSpeed),
    gust: kph(h.gust),
    windDirection: h.windDirection,
    swellHeight: h.swellHeight,
    swellPeriod: h.swellPeriod,
    swellDirection: h.swellDirection,
    waterTemperature: h.waterTemperature,
  }));
}

export async function fetchTideExtremes({ lat, lng }, hours = 48) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  const data = await sgFetch('/tide/extremes/point', {
    lat,
    lng,
    start: now.toISOString(),
    end: end.toISOString(),
  });
  return data.data.map((e) => ({
    time: new Date(e.time),
    type: e.type,
    height: e.height,
  }));
}

function kph(v) {
  return typeof v === 'number' ? v * 3.6 : null;
}

export async function fetchAll(point, hours = 48) {
  const [marine, tides] = await Promise.all([
    fetchMarine(point, hours),
    fetchTideExtremes(point, hours),
  ]);
  return { marine, tides, fetchedAt: new Date() };
}

export async function fetchDemo(hours = 48) {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const marine = [];
  for (let i = 0; i < hours; i++) {
    const t = new Date(now.getTime() + i * 3600 * 1000);
    const day = Math.floor(i / 24);
    marine.push({
      time: t,
      windSpeed: Math.max(0, Math.round(8 + 10 * Math.sin(i / 5) + day * 3 + Math.random() * 4)),
      gust: null,
      windDirection: 250 + Math.round(40 * Math.sin(i / 8)),
      swellHeight: +(1.2 + 0.8 * Math.sin(i / 9 + 1) + Math.random() * 0.3).toFixed(2),
      swellPeriod: Math.round(9 + 3 * Math.sin(i / 12)),
      swellDirection: 290 + Math.round(20 * Math.sin(i / 10)),
      waterTemperature: +(17 + Math.random()).toFixed(1),
    });
  }
  const tides = [];
  let tideTime = new Date(now.getTime() + 40 * 60 * 1000);
  let type = 'high';
  for (let i = 0; i < 8; i++) {
    tides.push({ time: new Date(tideTime), type, height: type === 'high' ? 4.1 : 1.2 });
    tideTime = new Date(tideTime.getTime() + 6.2 * 3600 * 1000);
    type = type === 'high' ? 'low' : 'high';
  }
  return { marine, tides, fetchedAt: new Date() };
}
