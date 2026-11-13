import { Storage } from './storage.js';

const SG_BASE = 'https://api.stormglass.io/v2';
const OM_MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';

function pick(arr, i) {
  return Array.isArray(arr) && i !== null && i !== undefined ? (arr[i] ?? null) : null;
}

export async function fetchMarine({ lat, lng }, hours = 48) {
  const marineUrl = `${OM_MARINE}?latitude=${lat}&longitude=${lng}` +
    `&hourly=swell_wave_height,swell_wave_period,swell_wave_direction,wave_height,sea_surface_temperature` +
    `&forecast_hours=${hours}&timezone=auto`;
  const weatherUrl = `${OM_FORECAST}?latitude=${lat}&longitude=${lng}` +
    `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&forecast_hours=${hours}&timezone=auto&wind_speed_unit=kmh`;
  const [marineRes, weatherRes] = await Promise.all([fetch(marineUrl), fetch(weatherUrl)]);
  if (!marineRes.ok) throw new Error(`Erreur Open-Meteo Marine ${marineRes.status}`);
  if (!weatherRes.ok) throw new Error(`Erreur Open-Meteo ${weatherRes.status}`);
  const mh = (await marineRes.json()).hourly ?? {};
  const wh = (await weatherRes.json()).hourly ?? {};
  const marineIndex = new Map();
  (mh.time ?? []).forEach((t, i) => marineIndex.set(t, i));
  return (wh.time ?? []).map((t, i) => {
    const mi = marineIndex.get(t) ?? null;
    return {
      time: new Date(t),
      windSpeed: pick(wh.wind_speed_10m, i),
      gust: pick(wh.wind_gusts_10m, i),
      windDirection: pick(wh.wind_direction_10m, i),
      swellHeight: pick(mh.swell_wave_height, mi) ?? pick(mh.wave_height, mi),
      swellPeriod: pick(mh.swell_wave_period, mi),
      swellDirection: pick(mh.swell_wave_direction, mi),
      waterTemperature: pick(mh.sea_surface_temperature, mi),
    };
  });
}

async function sgFetch(path, params) {
  const { apiKey, dailyQuota } = Storage.getSettings();
  if (!apiKey) {
    throw new Error('Clé API Stormglass manquante (onglet Réglages) — nécessaire pour les marées.');
  }
  const usage = Storage.getUsage();
  if (usage.count >= dailyQuota) {
    throw new Error(`Quota quotidien atteint (${dailyQuota} requêtes/jour). Les marées seront mises à jour demain.`);
  }
  const url = `${SG_BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (res.status === 401) {
    throw new Error('Clé API refusée par Stormglass (401).');
  }
  if (res.status === 429) {
    throw new Error('Trop de requêtes, réessayez dans quelques minutes.');
  }
  if (res.status === 402) {
    throw new Error(`Quota quotidien Stormglass épuisé (${dailyQuota} requêtes/jour). Réessayez demain.`);
  }
  if (!res.ok) {
    throw new Error(`Erreur Stormglass ${res.status}`);
  }
  usage.count += 1;
  Storage.saveUsage(usage);
  return res.json();
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
