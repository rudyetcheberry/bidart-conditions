import { Storage, DEFAULT_CRITERIA } from './storage.js';
import { fetchMarine, fetchTideExtremes, fetchDemo, fetchMetar } from './api.js';
import {
  matchesCriteria,
  findFavorableWindows,
  upcomingTideAlerts,
  degToDir,
} from './alerts.js';
import { renderSwellChart, renderTideChart } from './chart.js';

const $ = (id) => document.getElementById(id);

const APP_VERSION = '20';
const MARINE_TTL = 6 * 60 * 60 * 1000;
const TIDE_TTL = 24 * 60 * 60 * 1000;
const METAR_TTL = 30 * 60 * 1000;

let state = {
  settings: Storage.getSettings(),
  spots: Storage.getSpots(),
  activeSpotId: Storage.getActiveSpotId(),
  data: null,
  metar: null,
  metarError: null,
  editingSpotId: null,
};

let refreshing = false;

init();

function activeSpot() {
  return state.spots.find((s) => s.id === state.activeSpotId) || state.spots[0];
}

function init() {
  setupTabs();
  setupSpotBar();
  setupSettings();
  setupSpotsTab();
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

function setupSpotBar() {
  const sel = $('spot-select');
  if (!sel) return; // barre « Spot actif » retirée : le changement de spot se fait dans l'onglet Spots
  renderSpotSelect();
  sel.addEventListener('change', (e) => {
    state.activeSpotId = e.target.value;
    Storage.saveActiveSpotId(state.activeSpotId);
    state.data = null;
    refresh();
  });
}

function renderSpotSelect() {
  const sel = $('spot-select');
  if (!sel) return;
  sel.innerHTML = state.spots
    .map((s) => `<option value="${s.id}" ${s.id === state.activeSpotId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setupSettings() {
  $('api-key').value = state.settings.apiKey;
  $('btn-save-key').addEventListener('click', () => {
    state.settings.apiKey = $('api-key').value.trim();
    Storage.saveSettings(state.settings);
    refresh(true);
  });
  $('metar-relay').value = state.settings.metarRelay || '';
  $('btn-save-relay').addEventListener('click', () => {
    state.settings.metarRelay = $('metar-relay').value.trim().replace(/\/$/, '');
    Storage.saveSettings(state.settings);
    refresh(true);
  });
  $('demo-mode').addEventListener('change', (e) => {
    state.settings.demoMode = e.target.checked;
    Storage.saveSettings(state.settings);
    updateDemoBanner();
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

/* ---------- Onglet Spots ---------- */

function setupSpotsTab() {
  $('btn-add-spot').addEventListener('click', () => openSpotForm(null));
  $('btn-cancel-spot').addEventListener('click', () => {
    $('spot-edit-card').style.display = 'none';
    state.editingSpotId = null;
  });
  $('spot-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSpotForm();
  });
  renderSpotsList();
}

function renderSpotsList() {
  const list = $('spots-list');
  list.innerHTML = state.spots.map((s) => `
    <li>
      <div>
        <div class="spot-name">${escapeHtml(s.name)}${s.id === state.activeSpotId ? ' ⭐' : ''}</div>
        <div class="spot-coords">${s.lat.toFixed(4)}, ${s.lng.toFixed(4)} · houle ${s.config.swellMin}–${s.config.swellMax} m · vent ≤ ${s.config.windMax} km/h</div>
      </div>
      <div class="spot-actions">
        ${s.id === state.activeSpotId
          ? '<button class="use-btn active" disabled>Actif</button>'
          : `<button class="use-btn" data-use="${s.id}">Utiliser</button>`}
        <button data-edit="${s.id}">Modifier</button>
        <button data-delete="${s.id}">Supprimer</button>
      </div>
    </li>`).join('');

  list.querySelectorAll('[data-use]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeSpotId = btn.dataset.use;
      Storage.saveActiveSpotId(state.activeSpotId);
      renderSpotSelect();
      renderSpotsList();
      state.data = null;
      refresh();
    });
  });
  list.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openSpotForm(btn.dataset.edit));
  });
  list.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteSpot(btn.dataset.delete));
  });
}

function openSpotForm(spotId) {
  state.editingSpotId = spotId;
  const spot = spotId ? state.spots.find((s) => s.id === spotId) : null;
  const c = spot ? spot.config : DEFAULT_CRITERIA;
  $('spot-edit-title').textContent = spot ? `Modifier : ${spot.name}` : 'Nouveau spot';
  $('spot-name').value = spot ? spot.name : '';
  $('spot-lat').value = spot ? spot.lat : 43.4333;
  $('spot-lng').value = spot ? spot.lng : -1.5833;
  $('spot-swell-min').value = c.swellMin;
  $('spot-swell-max').value = c.swellMax;
  $('spot-period-min').value = c.periodMin;
  $('spot-wind-max').value = c.windMax;
  for (const opt of $('spot-wind-dir').options) {
    opt.selected = c.windDirs.includes(opt.value);
  }
  $('spot-tide-lead').value = String(c.tideLeadMin);
  for (const opt of $('spot-tide-states').options) {
    opt.selected = c.tideStates.includes(opt.value);
  }
  $('spot-edit-card').style.display = 'block';
  $('spot-edit-card').scrollIntoView({ behavior: 'smooth' });
}

function saveSpotForm() {
  const name = $('spot-name').value.trim() || 'Spot sans nom';
  const lat = parseFloat($('spot-lat').value);
  const lng = parseFloat($('spot-lng').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    alert('Latitude et longitude doivent être des nombres.');
    return;
  }
  const selectedDirs = [...$('spot-wind-dir').selectedOptions].map((o) => o.value);
  const config = {
    swellMin: num('spot-swell-min', DEFAULT_CRITERIA.swellMin),
    swellMax: num('spot-swell-max', DEFAULT_CRITERIA.swellMax),
    periodMin: num('spot-period-min', DEFAULT_CRITERIA.periodMin),
    windMax: num('spot-wind-max', DEFAULT_CRITERIA.windMax),
    windDirs: selectedDirs.length ? selectedDirs : ['any'],
    tideLeadMin: parseInt($('spot-tide-lead').value, 10) || 0,
    tideStates: [...$('spot-tide-states').selectedOptions].map((o) => o.value),
  };

  if (state.editingSpotId) {
    const spot = state.spots.find((s) => s.id === state.editingSpotId);
    spot.name = name;
    spot.lat = lat;
    spot.lng = lng;
    spot.config = config;
  } else {
    const id = 'spot-' + Date.now().toString(36);
    state.spots.push({ id, name, lat, lng, config });
    state.activeSpotId = id;
    Storage.saveActiveSpotId(id);
    renderSpotSelect();
  }
  Storage.saveSpots(state.spots);
  state.editingSpotId = null;
  $('spot-edit-card').style.display = 'none';
  renderSpotsList();
  state.data = null;
  refresh();
}

function deleteSpot(spotId) {
  if (state.spots.length <= 1) {
    alert('Impossible de supprimer le dernier spot.');
    return;
  }
  const spot = state.spots.find((s) => s.id === spotId);
  if (!confirm(`Supprimer le spot « ${spot.name} » ?`)) return;
  state.spots = state.spots.filter((s) => s.id !== spotId);
  Storage.saveSpots(state.spots);
  if (state.activeSpotId === spotId) {
    state.activeSpotId = state.spots[0].id;
    Storage.saveActiveSpotId(state.activeSpotId);
    renderSpotSelect();
    state.data = null;
    refresh();
  }
  renderSpotsList();
}

/* ---------- Données ---------- */

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

function updateActiveCriteriaLabel() {
  const spot = activeSpot();
  const c = spot.config;
  const dirs = c.windDirs.includes('any') || c.windDirs.length === 0
    ? 'tous secteurs'
    : c.windDirs.join(', ');
  $('active-criteria').textContent =
    `${spot.name} · houle ${c.swellMin}–${c.swellMax} m · période ≥ ${c.periodMin} s · vent ≤ ${c.windMax} km/h (${dirs})`;
}

async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  updateUsageLabel();
  updateActiveCriteriaLabel();
  const btn = $('btn-refresh');
  btn.disabled = true;

  try {
    if (state.settings.demoMode) {
      state.data = await fetchDemo();
      state.data.source = 'demo';
      setUpdateLabel(`Mis à jour à ${state.data.fetchedAt.toLocaleTimeString('fr-FR')} (mode démo)`);
      render();
      return;
    }

    loadMetar();

    const spot = activeSpot();
    const rawCache = Storage.getLastData(spot.id);
    const cached = rawCache && rawCache.source === 'live' ? reviveData(rawCache) : null;
    const now = Date.now();
    const marineFresh = cached && now - cached.fetchedAt.getTime() < MARINE_TTL;

    const rawTides = Storage.getTides();
    const tides = rawTides
      ? rawTides.tides.map((t) => ({ ...t, time: new Date(t.time) }))
      : [];
    const tidesUsable = tides.length > 0
      && tides.some((t) => t.time > new Date())
      && now - new Date(rawTides.fetchedAt).getTime() < TIDE_TTL;

    if (!force && cached && marineFresh && tidesUsable) {
      state.data = { ...cached, tides };
      const nextMs = cached.fetchedAt.getTime() + MARINE_TTL - now;
      const minutes = Math.max(1, Math.round(nextMs / 60000));
      setUpdateLabel(`Données de ${cached.fetchedAt.toLocaleTimeString('fr-FR')} · actualisation dans ~${minutes} min`);
      render();
      return;
    }

    const errors = [];
    const data = cached ? reviveData(rawCache) : { marine: [], tides, fetchedAt: new Date(0) };

    if (force || !marineFresh) {
      try {
        data.marine = await fetchMarine(spot);
        data.fetchedAt = new Date();
      } catch (err) {
        errors.push(`vent/houle : ${err.message}`);
      }
    }

    const tidesStillUsable = data.tides.length > 0
      && data.tides.some((t) => t.time > new Date())
      && now - new Date(rawTides ? rawTides.fetchedAt : 0).getTime() < TIDE_TTL;
    if (!tidesStillUsable && (force ? tideRetryAllowed() : true)) {
      try {
        const fetched = await fetchTideExtremes(spot);
        data.tides = fetched;
        Storage.saveTides({ tides: fetched, fetchedAt: new Date().toISOString() });
      } catch (err) {
        errors.push(`marées : ${err.message}`);
      }
    }

    if (data.marine.length === 0) {
      $('current-cards').innerHTML = `<p class="hint">${errors.join(' · ') || 'Aucune donnée.'}</p>`;
      setUpdateLabel('Erreur de chargement');
      updateUsageLabel();
      return;
    }

    data.source = 'live';
    state.data = data;
    Storage.saveLastData(spot.id, data);
    const parts = [errors.length ? 'Données du' : 'Mis à jour à', data.fetchedAt.toLocaleTimeString('fr-FR')];
    if (errors.length) parts.push(errors.join(' · '));
    setUpdateLabel(parts.join(' '));
    render();
    updateUsageLabel();
  } finally {
    refreshing = false;
    btn.disabled = false;
  }
}

function tideRetryAllowed() {
  const rawTides = Storage.getTides();
  if (!rawTides) return true;
  return Date.now() - new Date(rawTides.fetchedAt).getTime() > 60 * 60 * 1000;
}

async function loadMetar() {
  const relay = state.settings.metarRelay;
  if (!relay) { state.metar = null; state.metarError = null; return; }
  const raw = Storage.getMetar();
  if (raw && Date.now() - new Date(raw.fetchedAt).getTime() < METAR_TTL) {
    state.metar = { ...raw.data, time: new Date(raw.data.time) };
    state.metarError = null;
    renderCurrent();
    return;
  }
  try {
    const metar = await fetchMetar(relay);
    state.metar = metar;
    state.metarError = null;
    Storage.saveMetar({ data: { ...metar, time: metar.time.toISOString() }, fetchedAt: new Date().toISOString() });
  } catch (err) {
    state.metarError = err.message;
  }
  renderCurrent();
}

/* ---------- Rendu ---------- */

function render() {
  if (!state.data) return;
  renderCurrent();
  renderTides();
  renderForecast();
  renderWindows();
  checkAlerts();
}

function renderCurrent() {
  const spot = activeSpot();
  const now = new Date();
  let hour = state.data.marine[0];
  let bestDelta = Infinity;
  for (const h of state.data.marine) {
    const d = Math.abs(h.time - now);
    if (d < bestDelta) { bestDelta = d; hour = h; }
  }
  // Si un relevé METAR LFBZ récent existe, il remplace le vent prévu
  // (vent mesuré = vérité terrain) pour la carte Vent et le verdict.
  const metar = freshMetar();
  if (metar && typeof metar.windSpeed === 'number') {
    hour = { ...hour, windSpeed: metar.windSpeed, gust: metar.gust, windDirection: metar.windDirection };
  }
  const { checks } = matchesCriteria(hour, spot.config);
  const nextTide = state.data.tides.find((t) => t.time > now);
  const cards = [
    metric('Houle (totale)', `${fmt(hour.swellHeight, 1)} m`,
      `${degToDir(hour.swellDirection)} · pic ${fmt(hour.swellPeriod, 0)} s`
      + (hour.swellPrimaryHeight !== null && hour.swellPrimaryHeight !== undefined
        ? ` · primaire ${fmt(hour.swellPrimaryHeight, 1)} m`
        : ''),
      checks.swell && checks.period),
    metric(metar && typeof metar.windSpeed === 'number' ? 'Vent (observé LFBZ)' : 'Vent',
      `${fmt(hour.windSpeed, 0)} km/h`,
      `${degToDir(hour.windDirection)}${hour.gust ? ` · rafales ${fmt(hour.gust, 0)} km/h` : ''}`,
      checks.wind && checks.windDir),
    metric('Eau', `${fmt(hour.waterTemperature, 1)} °C`, '', null),
    (!metar ? metarCard() : ''),
    metric('Marée', nextTide
      ? `${nextTide.type === 'high' ? 'Haute' : 'Basse'} à ${nextTide.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
      : '—', '', null),
  ];
  $('current-cards').innerHTML = cards.join('');
}

function freshMetar() {
  if (!state.metar || !(state.metar.time instanceof Date)) return null;
  const age = Date.now() - state.metar.time.getTime();
  // Relevé METAR de plus de 3 h : trop ancien pour représenter l'instant présent.
  if (age > 3 * 60 * 60 * 1000) return null;
  return state.metar;
}

function metarCard() {
  if (!state.settings.metarRelay) return '';  if (state.metarError) {
    return `<div class="metric-card">
      <span class="label">Vent observé (LFBZ)</span>
      <div class="detail">${state.metarError}</div>
    </div>`;
  }
  if (!state.metar) return '';
  const m = state.metar;
  const dir = typeof m.windDirection === 'number' ? degToDir(m.windDirection) : 'variable';
  const detail = `${dir} · mesuré à ${m.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  return `<div class="metric-card">
    <span class="label">Vent observé (LFBZ)</span>
    <div class="value">${fmt(m.windSpeed, 0)} km/h</div>
    <div class="detail">${detail}${m.gust ? ` · rafales ${fmt(m.gust, 0)}` : ''}</div>
  </div>`;
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
  renderTideChart($('tide-chart'), state.data.tides, new Date());
}

function renderForecast() {
  renderSwellChart($('swell-chart'), state.data.marine, activeSpot().config);
  const tbody = $('forecast-table').querySelector('tbody');
  tbody.innerHTML = state.data.marine
    .filter((_, i) => i % 2 === 0)
    .slice(0, 24)
    .map((h) => {
      const { ok } = matchesCriteria(h, activeSpot().config);
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
  const windows = findFavorableWindows(state.data.marine, activeSpot().config);
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
  const spot = activeSpot();
  const now = new Date();
  const current = state.data.marine.find((h) => Math.abs(h.time - now) < 60 * 60 * 1000);
  const bodyParts = [];
  if (current) {
    // Priorité au vent observé LFBZ s'il est récent.
    const metar = freshMetar();
    let evalHour = current;
    if (metar && typeof metar.windSpeed === 'number') {
      evalHour = { ...current, windSpeed: metar.windSpeed, gust: metar.gust, windDirection: metar.windDirection };
    }
    const { ok } = matchesCriteria(evalHour, spot.config);
    if (ok) {
      bodyParts.push(
        `${spot.name} : conditions favorables — houle ${fmt(evalHour.swellHeight, 1)} m, ` +
        `vent ${fmt(evalHour.windSpeed, 0)} km/h (${degToDir(evalHour.windDirection)}).`
      );
    }
  }
  for (const t of upcomingTideAlerts(state.data.tides, spot.config, now)) {
    bodyParts.push(
      `${t.type === 'high' ? 'Marée haute' : 'Marée basse'} dans ${t.minutesAway} min (${fmt(t.height, 1)} m).`
    );
  }
  if (bodyParts.length === 0) return;
  const key = `bidart-conditions.notified.${spot.id}.${now.toISOString().slice(0, 13)}`;
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

function num(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}

function fmt(v, digits) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}
