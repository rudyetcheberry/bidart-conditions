import { Storage, DEFAULT_CRITERIA } from './storage.js';
import { fetchMarine, fetchTideExtremes, fetchDemo, fetchMetar } from './api.js';
import {
  matchesCriteria,
  findFavorableWindows,
  upcomingTideAlerts,
  degToDir,
} from './alerts.js';
import { renderSwellChart, renderTideChart, tideCoefficient } from './chart.js';
import { fetchHistoricalConditions } from './api.js';

const $ = (id) => document.getElementById(id);

const APP_VERSION = '26';
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
  sessions: Storage.getSessions(),
};

let sessionSnapshotCache = null; // { when: ms, snapshot } — conditions chargées pour la date du formulaire
let analysisCriteria = null; // critères déduits des meilleures sessions

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
  setupSessionsTab();
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
  renderSessionSpotSelect();
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
  updateSessionConditionsHint();
  checkAlerts();
}

// --- Onglet Sessions (journal des sorties de surf) ---

function renderSessionSpotSelect() {
  const sel = $('session-spot');
  if (!sel) return;
  sel.innerHTML = state.spots
    .map((s) => `<option value="${s.id}" ${s.id === state.activeSpotId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
    .join('');
}

function setupSessionsTab() {
  const spotSel = $('session-spot');
  if (!spotSel) return;
  renderSessionSpotSelect();
  const dateInput = $('session-date');
  const setNow = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    dateInput.value = d.toISOString().slice(0, 16);
  };
  setNow();
  // Le changement de date recharge les conditions (fenêtre 48 h ou archives Open-Meteo).
  dateInput.addEventListener('change', loadSessionConditions);
  spotSel.addEventListener('change', loadSessionConditions);
  $('btn-save-session').addEventListener('click', () => {
    const spot = state.spots.find((s) => s.id === spotSel.value) || activeSpot();
    const when = dateInput.value ? new Date(dateInput.value) : new Date();
    const ratingVal = $('session-rating').value;
    const session = {
      id: 's' + Date.now(),
      date: when.toISOString(),
      spotId: spot.id,
      spotName: spot.name,
      rating: ratingVal ? parseInt(ratingVal, 10) : null,
      notes: $('session-notes').value.trim(),
      conditions: snapshotFor(when),
    };
    state.sessions = [session].concat(state.sessions);
    Storage.saveSessions(state.sessions);
    $('session-notes').value = '';
    $('session-rating').value = '';
    setNow();
    renderSessionsList();
  });
  $('btn-apply-analysis').addEventListener('click', () => {
    if (!analysisCriteria) return;
    const spot = activeSpot();
    const cfg = spot.config;
    if (analysisCriteria.swellMin !== null && analysisCriteria.swellMin !== undefined) cfg.swellMin = analysisCriteria.swellMin;
    if (analysisCriteria.swellMax !== null && analysisCriteria.swellMax !== undefined) cfg.swellMax = analysisCriteria.swellMax;
    if (analysisCriteria.periodMin) cfg.periodMin = analysisCriteria.periodMin;
    if (analysisCriteria.windMax) cfg.windMax = analysisCriteria.windMax;
    Storage.saveSpots(state.spots);
    renderSpotsList();
    const btn = $('btn-apply-analysis');
    btn.textContent = 'Appliqué à ' + spot.name + ' ✓';
  });
  renderSessionsList();
}

async function loadSessionConditions() {
  const dateInput = $('session-date');
  if (!dateInput || !dateInput.value) return;
  const when = new Date(dateInput.value);
  const near = syncSnapshotFromMarine(when);
  if (near) {
    sessionSnapshotCache = { when: when.getTime(), snapshot: near };
    updateSessionConditionsHint(when);
    return;
  }
  const el = $('session-conditions');
  el.textContent = 'Recherche des conditions du ' + when.toLocaleString('fr-FR') + '…';
  try {
    const spot = state.spots.find((s) => s.id === $('session-spot').value) || activeSpot();
    const raw = await fetchHistoricalConditions({ lat: spot.lat, lng: spot.lng }, when);
    const snapshot = historicalToSnapshot(raw);
    sessionSnapshotCache = { when: when.getTime(), snapshot: snapshot };
    el.textContent = 'Conditions du ' + when.toLocaleString('fr-FR') + ' : '
      + (snapshot ? snapshot.text : 'indisponibles pour cette heure');
  } catch (err) {
    sessionSnapshotCache = null;
    el.textContent = 'Conditions indisponibles pour cette date (archive trop récente — ~5 jours de délai — ou erreur réseau).';
  }
}

function snapshotFor(when) {
  const near = syncSnapshotFromMarine(when);
  if (near) return near;
  if (sessionSnapshotCache && Math.abs(sessionSnapshotCache.when - when.getTime()) < 2 * 3600 * 1000) {
    return sessionSnapshotCache.snapshot;
  }
  return null;
}

function historicalToSnapshot(raw) {
  if (!raw) return null;
  const parts = [];
  if (typeof raw.swellHeight === 'number') parts.push('houle ' + fmt(raw.swellHeight, 1) + ' m');
  if (typeof raw.swellPeriod === 'number') parts.push(fmt(raw.swellPeriod, 0) + ' s');
  if (typeof raw.windSpeed === 'number') {
    parts.push('vent ' + fmt(raw.windSpeed, 0) + ' km/h ' + degToDir(raw.windDirection));
  }
  if (typeof raw.gust === 'number') parts.push('rafales ' + fmt(raw.gust, 0));
  if (parts.length === 0) return null;
  return {
    text: parts.join(' · '),
    swellHeight: typeof raw.swellHeight === 'number' ? raw.swellHeight : null,
    swellPeriod: typeof raw.swellPeriod === 'number' ? raw.swellPeriod : null,
    windSpeed: typeof raw.windSpeed === 'number' ? raw.windSpeed : null,
  };
}

function syncSnapshotFromMarine(when) {
  if (!state.data || !state.data.marine || state.data.marine.length === 0) return null;
  let hour = state.data.marine[0];
  let best = Infinity;
  for (const h of state.data.marine) {
    const d = Math.abs(h.time - when);
    if (d < best) { best = d; hour = h; }
  }
  if (best > 3 * 3600 * 1000) return null;
  const metar = freshMetar();
  const observed = metar && typeof metar.windSpeed === 'number';
  const windSpeed = observed ? metar.windSpeed : hour.windSpeed;
  const windDirection = observed ? metar.windDirection : hour.windDirection;
  const parts = [
    'houle ' + fmt(hour.swellHeight, 1) + ' m',
    fmt(hour.swellPeriod, 0) + ' s',
    'vent ' + fmt(windSpeed, 0) + ' km/h ' + degToDir(windDirection),
  ];
  const gust = observed && metar.gust ? metar.gust : hour.gust;
  if (gust) parts.push('rafales ' + fmt(gust, 0));
  const tide = state.data.tides.find((t) => Math.abs(t.time - when) < 6 * 3600 * 1000);
  if (tide) parts.push(tide.type === 'high' ? 'près marée haute' : 'près marée basse');
  return {
    text: parts.join(' · '),
    swellHeight: typeof hour.swellHeight === 'number' ? hour.swellHeight : null,
    swellPeriod: typeof hour.swellPeriod === 'number' ? hour.swellPeriod : null,
    windSpeed: typeof windSpeed === 'number' ? windSpeed : null,
  };
}

function updateSessionConditionsHint(when) {
  const el = $('session-conditions');
  if (!el) return;
  const w = when || new Date();
  const snap = syncSnapshotFromMarine(w);
  el.textContent = 'Conditions actuelles : ' + (snap ? snap.text : 'indisponibles');
}

function renderSessionsList() {
  const list = $('sessions-list');
  if (!list) return;
  const sessions = state.sessions || [];
  const stats = $('sessions-stats');
  if (stats) {
    const now = new Date();
    const monthCount = sessions.filter((s) => {
      const d = new Date(s.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
    stats.textContent = sessions.length === 0
      ? 'Aucune session enregistrée.'
      : `${sessions.length} session${sessions.length > 1 ? 's' : ''} · ${monthCount} ce mois-ci`;
  }
  if (sessions.length === 0) {
    list.innerHTML = '<li class="hint">Aucune session enregistrée.</li>';
    return;
  }
  list.innerHTML = sessions.map((s) => {
    const d = new Date(s.date);
    const stars = s.rating ? '★'.repeat(s.rating) : '';
    const cond = s.conditions && s.conditions.text ? `<div class="spot-coords">${escapeHtml(s.conditions.text)}</div>` : '';
    const notes = s.notes ? `<div class="spot-coords">${escapeHtml(s.notes)}</div>` : '';
    return `<li>
      <div>
        <div class="spot-name">${d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${escapeHtml(s.spotName)} ${stars}</div>
        ${cond}${notes}
      </div>
      <div class="spot-actions"><button data-del-session="${s.id}">Supprimer</button></div>
    </li>`;
  }).join('');
  list.querySelectorAll('[data-del-session]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sessions = state.sessions.filter((s) => s.id !== btn.dataset.delSession);
      Storage.saveSessions(state.sessions);
      renderSessionsList();
    });
  });
  renderSessionsAnalysis();
}

// Déduit les conditions idéales des meilleures sessions (★★★★ et ★★★★★).
function renderSessionsAnalysis() {
  const el = $('sessions-analysis');
  const btn = $('btn-apply-analysis');
  if (!el) return;
  const good = (state.sessions || []).filter((s) => s.rating && s.rating >= 4
    && s.conditions && typeof s.conditions.swellHeight === 'number'
    && typeof s.conditions.windSpeed === 'number');
  if (good.length < 2) {
    analysisCriteria = null;
    el.textContent = 'Enregistrez au moins 2 sessions notées ★★★★ ou ★★★★★ : l\'app en déduira vos conditions idéales pour le spot actif.';
    if (btn) btn.classList.add('hidden');
    return;
  }
  const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
  const swell = good.map((s) => s.conditions.swellHeight).sort((a, b) => a - b);
  const period = good.map((s) => s.conditions.swellPeriod).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const wind = good.map((s) => s.conditions.windSpeed).sort((a, b) => a - b);
  analysisCriteria = {
    swellMin: Math.round(swell[0] * 10) / 10,
    swellMax: Math.round(swell[swell.length - 1] * 10) / 10,
    periodMin: period.length ? Math.round(median(period)) : null,
    windMax: wind.length ? Math.round(wind[wind.length - 1] + 2) : null,
  };
  let html = 'D\'après vos ' + good.length + ' meilleures sessions : houle <strong>'
    + analysisCriteria.swellMin + '–' + analysisCriteria.swellMax + ' m</strong>';
  if (analysisCriteria.periodMin) html += ' · période ≥ <strong>' + analysisCriteria.periodMin + ' s</strong>';
  if (analysisCriteria.windMax) html += ' · vent ≤ <strong>' + analysisCriteria.windMax + ' km/h</strong>';
  html += '.';
  el.innerHTML = html;
  if (btn) {
    btn.classList.remove('hidden');
    btn.textContent = 'Appliquer au spot actif (' + activeSpot().name + ')';
  }
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
  const nextCoef = nextTide ? tideCoefficient(state.data.tides, state.data.tides.indexOf(nextTide)) : null;
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
      : '—',
      nextCoef !== null && nextCoef !== undefined ? `coef. ≈ ${nextCoef}` : '', null),
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
