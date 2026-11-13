import { Storage } from './storage.js';
import { fetchMarine, fetchTideExtremes, fetchDemo } from './api.js';
import {
  matchesCriteria,
  findFavorableWindows,
  upcomingTideAlerts,
  degToDir,
} from './alerts.js';

const $ = (id) => document.getElementById(id);

const APP_VERSION = '7';
const MARINE_TTL = 6 * 60 * 60 * 1000;
const TIDE_TTL = 24 * 60 * 60 * 1000;

let state = {
  data: null,
  config: Storage.getAlertConfig(),
  settings: Storage.getSettings(),
};

init();

function init() {
  setupTabs();
  setupSettings();
  setupAlertForm();
  setupNotifications();
  $('demo-mode').checked = state.settings.demoMode;
  updateDemoBanner();
  $('btn-refresh').addEventListener('click', () => refresh(true));
  const versionEl = $('app-version');
  if (versionEl) versionEl.textContent = `Version ${APP_VERSION} · code à jour`;
  registerServiceWorker();
  refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 15 * 60 * 1000);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'activated' && navigator.serviceWorker.controller) {
          window.location.reload();
        }
      });
    });
  }).catch(() => {});
}

function setupTabs() {
  document.querySelectorAll('.bottom-nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bottom-nav button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.tab).classList.add('active');
    });
  });
}

function setupSettings() {
  $('api-key').value = state.settings.apiKey;
  $('lat').value = state.settings.point.lat;
  $('lng').value = state.settings.point.lng;
  $('btn-save-key').addEventListener('click', () => {
    state.settings.apiKey = $('api-key').value.trim();
    Storage.saveSettings(state.settings);
    refresh();
  });
  $('btn-save-point').addEventListener('click', () => {
    state.settings.point = {
      lat: parseFloat($('lat').value) || state.settings.point.lat,
      lng: parseFloat($('lng').value) || state.settings.point.lng,
    };
    Storage.saveSettings(state.settings);
    refresh();
  });
  const dailyQuotaInput = $('daily-quota');
  if (dailyQuotaInput) {
    dailyQuotaInput.value = state.settings.dailyQuota;
    $('btn-save-quota').addEventListener('click', () => {
      state.settings.dailyQuota = Math.max(1, parseInt(dailyQuotaInput.value, 10) || 10);
      Storage.saveSettings(state.settings);
      updateUsageLabel();
    });
  }
  $('demo-mode').addEventListener('change', (e) => {
    state.settings.demoMode = e.target.checked;
    Storage.saveSettings(state.settings);
    updateDemoBanner();
    refresh();
  });
}

function setupAlertForm() {
  const c = state.config;
  $('swell-min').value = c.swellMin;
  $('swell-max').value = c.swellMax;
  $('period-min').value = c.periodMin;
  $('wind-max').value = c.windMax;
  for (const opt of $('wind-dir').options) {
    opt.selected = c.windDirs.includes(opt.value);
  }
  $('tide-lead').value = String(c.tideLeadMin);
  for (const opt of $('tide-states').options) {
    opt.selected = c.tideStates.includes(opt.value);
  }
  $('alert-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const selectedDirs = [...$('wind-dir').selectedOptions].map((o) => o.value);
    state.config = {
      swellMin: num('swell-min', c.swellMin),
      swellMax: num('swell-max', c.swellMax),
      periodMin: num('period-min', c.periodMin),
      windMax: num('wind-max', c.windMax),
      windDirs: selectedDirs.length ? selectedDirs : ['any'],
      tideLeadMin: parseInt($('tide-lead').value, 10) || 0,
      tideStates: [...$('tide-states').selectedOptions].map((o) => o.value),
    };
    Storage.saveAlertConfig(state.config);
    render();
  });
}

function num(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}

function setupNotifications() {
  updateNotifyStatus();
  $('btn-notify').addEventListener('click', async () => {
    if (!('Notification' in window)) {
      $('notify-status').textContent = 'Notifications non prises en charge par ce navigateur.';
      return;
    }
    const perm = await Notification.requestPermission();
    updateNotifyStatus(perm);
  });
}

function updateNotifyStatus(perm) {
  const p = perm || (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const messages = {
    granted: 'Notifications activées.',
    denied: 'Notifications refusées : autorisez-les dans les réglages du navigateur.',
    default: 'Notifications non activées.',
    unsupported: 'Notifications non prises en charge.',
  };
  $('notify-status').textContent = messages[p] || messages.default;
}

function reviveData(data) {
  return {
    ...data,
    fetchedAt: new Date(data.fetchedAt),
    marine: data.marine.map((h) => ({ ...h, time: new Date(h.time) })),
    tides: data.tides.map((t) => ({ ...t, time: new Date(t.time) })),
  };
}

function setUpdateLabel(text) {
  $('last-update').textContent = text;
}

function updateDemoBanner() {
  const banner = $('demo-banner');
  if (banner) banner.classList.toggle('hidden', !state.settings.demoMode);
}

function updateUsageLabel() {
  const el = $('usage-status');
  if (!el) return;
  const { dailyQuota } = state.settings;
  const { count } = Storage.getUsage();
  el.textContent = `Requêtes Stormglass aujourd'hui : ${count} / ${dailyQuota}`;
}

async function refresh(force = false) {
  updateUsageLabel();
  if (state.settings.demoMode) {
    const btn = $('btn-refresh');
    btn.disabled = true;
    try {
      state.data = await fetchDemo();
      state.data.source = 'demo';
      setUpdateLabel(`Mis à jour à ${state.data.fetchedAt.toLocaleTimeString('fr-FR')} (mode démo)`);
      render();
    } finally {
      btn.disabled = false;
    }
    return;
  }

  const rawCache = Storage.getLastData();
  const cached = rawCache && rawCache.source === 'live' ? reviveData(rawCache) : null;
  const now = Date.now();
  const marineFresh = cached && now - cached.fetchedAt.getTime() < MARINE_TTL;
  const tidesFresh = cached
    && now - cached.fetchedAt.getTime() < TIDE_TTL
    && cached.tides.some((t) => t.time > new Date());
  const tideAge = cached ? now - cached.fetchedAt.getTime() : Infinity;

  if (!force && marineFresh && tidesFresh) {
    state.data = cached;
    const nextMs = cached.fetchedAt.getTime() + MARINE_TTL - now;
    const minutes = Math.max(1, Math.round(nextMs / 60000));
    setUpdateLabel(`Données de ${cached.fetchedAt.toLocaleTimeString('fr-FR')} · actualisation dans ~${minutes} min`);
    render();
    return;
  }

  const btn = $('btn-refresh');
  btn.disabled = true;
  const data = cached ? reviveData(rawCache) : { marine: [], tides: [], fetchedAt: new Date(0) };
  const errors = [];

  if (force || !marineFresh) {
    try {
      data.marine = await fetchMarine(state.settings.point);
      data.fetchedAt = new Date();
    } catch (err) {
      errors.push(`vent/houle : ${err.message}`);
    }
  }
  const tidesUsable = data.tides.length > 0 && data.tides.some((t) => t.time > new Date());
  if (force ? (!tidesUsable || tideAge > 60 * 60 * 1000) : !tidesFresh) {
    try {
      data.tides = await fetchTideExtremes(state.settings.point);
      data.fetchedAt = new Date();
    } catch (err) {
      errors.push(`marées : ${err.message}`);
    }
  }
  btn.disabled = false;

  if (data.marine.length === 0) {
    $('current-cards').innerHTML = `<p class="hint">${errors.join(' · ') || 'Aucune donnée.'}</p>`;
    setUpdateLabel('Erreur de chargement');
    updateUsageLabel();
    return;
  }

  data.source = 'live';
  state.data = data;
  Storage.saveLastData(data);
  const parts = [errors.length ? 'Données du' : 'Mis à jour à', data.fetchedAt.toLocaleTimeString('fr-FR')];
  if (errors.length) parts.push(errors.join(' · '));
  setUpdateLabel(parts.join(' '));
  render();
  updateUsageLabel();
}

function render() {
  if (!state.data) return;
  renderCurrent();
  renderTides();
  renderForecast();
  renderWindows();
  checkAlerts();
}

function renderCurrent() {
  const now = new Date();
  let hour = state.data.marine[0];
  let bestDelta = Infinity;
  for (const h of state.data.marine) {
    const d = Math.abs(h.time - now);
    if (d < bestDelta) { bestDelta = d; hour = h; }
  }
  const { ok, checks } = matchesCriteria(hour, state.config);
  const nextTide = state.data.tides.find((t) => t.time > now);
  const cards = [
    metric('Houle', `${fmt(hour.swellHeight, 1)} m`,
      `${degToDir(hour.swellDirection)} · ${fmt(hour.swellPeriod, 0)} s`,
      checks.swell && checks.period),
    metric('Vent', `${fmt(hour.windSpeed, 0)} km/h`,
      `${degToDir(hour.windDirection)}${hour.gust ? ` · rafales ${fmt(hour.gust, 0)} km/h` : ''}`,
      checks.wind && checks.windDir),
    metric('Eau', `${fmt(hour.waterTemperature, 1)} °C`, '', null),
    metric('Marée', nextTide
      ? `${nextTide.type === 'high' ? 'Haute' : 'Basse'} à ${nextTide.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
      : '—', '', null),
  ];
  const banner = `<div class="metric-card" style="grid-column: 1 / -1;">
    <span class="label">Conditions actuelles vs vos critères</span>
    <div class="value">${ok ? 'Favorables' : 'Non favorables'}</div>
    <span class="badge ${ok ? 'good' : 'bad'}">${ok ? 'Alerte justifiée' : "Pas d'alerte"}</span>
  </div>`;
  $('current-cards').innerHTML = banner + cards.join('');
}

function metric(label, value, detail, favorable) {
  const badge = favorable === null || favorable === undefined
    ? ''
    : `<span class="badge ${favorable ? 'good' : 'bad'}">${favorable ? 'OK' : 'hors critères'}</span>`;
  return `<div class="metric-card">
    <span class="label">${label}</span>
    <div class="value">${value}</div>
    <div class="detail">${detail}</div>
    ${badge}
  </div>`;
}

function renderTides() {
  const now = new Date();
  const next = state.data.tides.filter((t) => t.time > now).slice(0, 4);
  if (next.length === 0) {
    $('tide-list').innerHTML = state.data.tides.length === 0
      ? '<li class="hint">Marées indisponibles : clé Stormglass ou quota requis. Le bouton ↻ réessaie (1 requête/jour suffit).</li>'
      : '<li class="hint">Aucune marée à venir sur la période.</li>';
    return;
  }
  $('tide-list').innerHTML = next.map((t) => `<li>
      <span>${t.type === 'high' ? '🌊 Marée haute' : '🏖️ Marée basse'}</span>
      <span>${t.time.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${fmt(t.height, 1)} m</span>
    </li>`).join('');
}

function renderForecast() {
  const tbody = $('forecast-table').querySelector('tbody');
  tbody.innerHTML = state.data.marine
    .filter((_, i) => i % 2 === 0)
    .slice(0, 24)
    .map((h) => {
      const { ok } = matchesCriteria(h, state.config);
      const nextTide = state.data.tides.find((t) => Math.abs(t.time - h.time) < 30 * 60 * 1000);
      return `<tr class="${ok ? 'favorable' : ''}">
        <td>${h.time.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${fmt(h.swellHeight, 1)} m</td>
        <td>${fmt(h.swellPeriod, 0)} s</td>
        <td>${fmt(h.windSpeed, 0)} km/h</td>
        <td>${degToDir(h.windDirection)}</td>
        <td>${nextTide ? (nextTide.type === 'high' ? 'haute' : 'basse') : ''}</td>
      </tr>`;
    }).join('');
}

function renderWindows() {
  const windows = findFavorableWindows(state.data.marine, state.config);
  $('windows-list').innerHTML = windows.length
    ? windows.map((w) => `<li>
        <span>${rangeLabel(w.start, w.end)}</span>
        <span class="badge good">${w.hours.length} h</span>
      </li>`).join('')
    : '<li class="hint">Aucune fenêtre favorable dans les 48 h avec vos critères.</li>';
}

function rangeLabel(start, end) {
  const f = (d) => d.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return start.getTime() === end.getTime() ? f(start) : `${f(start)} → ${f(end)}`;
}

function checkAlerts() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const now = new Date();
  const current = state.data.marine.find((h) => Math.abs(h.time - now) < 60 * 60 * 1000);
  const bodyParts = [];
  if (current) {
    const { ok } = matchesCriteria(current, state.config);
    if (ok) {
      bodyParts.push(
        `Conditions favorables maintenant : houle ${fmt(current.swellHeight, 1)} m, ` +
        `vent ${fmt(current.windSpeed, 0)} km/h (${degToDir(current.windDirection)}).`
      );
    }
  }
  for (const t of upcomingTideAlerts(state.data.tides, state.config, now)) {
    bodyParts.push(
      `${t.type === 'high' ? 'Marée haute' : 'Marée basse'} dans ${t.minutesAway} min (${fmt(t.height, 1)} m).`
    );
  }
  if (bodyParts.length === 0) return;
  const key = `bidart-conditions.notified.${now.toISOString().slice(0, 13)}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  navigator.serviceWorker.ready.then((reg) => {
    reg.showNotification('Conditions Bidart', {
      body: bodyParts.join(' '),
      icon: 'icons/icon-192.png',
      tag: 'bidart-conditions',
    });
  });
}

function fmt(v, digits) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}
