import { Storage, DEFAULT_CRITERIA } from './storage.js';
import { fetchMarine, fetchTideExtremes, fetchDemo, fetchMetar, fetchHistoricalConditions } from './api.js';
import {
  matchesCriteria,
  findFavorableWindows,
  upcomingTideAlerts,
  tideContextAt,
  scoreChecks,
  degToDir,
} from './alerts.js';
import { renderSwellChart, renderTideChart, tideCoefficient } from './chart.js';

const $ = (id) => document.getElementById(id);

const APP_VERSION = '34';
const MARINE_TTL = 6 * 60 * 60 * 1000;
const TIDE_TTL = 24 * 60 * 60 * 1000;
const METAR_TTL = 30 * 60 * 1000;

let state = {
  settings: Storage.getSettings(),
  spots: Storage.getSpots(),
  // Spot « affiché » (détails sous le classement) : choix local, plus de spot
  // actif persistant. Par défaut : le meilleur spot du classement.
  selectedSpotId: null,
  spotsData: {}, // { spotId: { marine, fetchedAt, source } }
  tides: [], // marées partagées (Boucau-Bayonne)
  metar: null,
  metarError: null,
  editingSpotId: null,
  sessions: Storage.getSessions(),
};

let sessionSnapshotCache = null; // { when: ms, snapshot } — conditions chargées pour la date du formulaire
let spotsMap = null; // instance Leaflet de la carte des spots
let spotMarkers = {};

let refreshing = false;

init();

function init() {
  updateNightMode();
  setupTabs();
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

// Thème clair/sombre selon le réglage utilisateur (nuit par défaut).
function updateNightMode() {
  const night = state.settings.theme !== 'light';
  const changed = document.body.classList.contains('night') !== night;
  document.body.classList.toggle('night', night);
  if (changed && spotDataValues().length) render(); // re-rendu pour adapter les couleurs des graphiques
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
      // La carte Leaflet doit être initialisée quand son conteneur est visible.
      if (btn.dataset.tab === 'tab-spots') setTimeout(renderSpotsMap, 60);
    });
  });
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
  const nightModeInput = $('night-mode');
  if (nightModeInput) {
    nightModeInput.checked = state.settings.theme !== 'light';
    nightModeInput.addEventListener('change', (e) => {
      state.settings.theme = e.target.checked ? 'dark' : 'light';
      Storage.saveSettings(state.settings);
      updateNightMode();
    });
  }
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
  if (spotsMap) renderSpotsMap();
  const list = $('spots-list');
  list.innerHTML = state.spots.map((s) => `
    <li>
      <div>
        <div class="spot-name">${escapeHtml(s.name)}</div>
        <div class="spot-coords">${s.lat.toFixed(4)}, ${s.lng.toFixed(4)} · houle ${s.config.swellMin}–${s.config.swellMax} m · vent ≤ ${s.config.windMax} km/h</div>
      </div>
      <div class="spot-actions">
        <button data-edit="${s.id}">Modifier</button>
        <button data-delete="${s.id}">Supprimer</button>
      </div>
    </li>`).join('');

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
  const phases = c.tidePhases || [];
  for (const opt of $('spot-tide-phases').options) {
    opt.selected = phases.includes(opt.value);
  }
  $('spot-coef-min').value = typeof c.coefMin === 'number' ? c.coefMin : 0;
  $('spot-coef-max').value = typeof c.coefMax === 'number' ? c.coefMax : 120;
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
  const selectedPhases = [...$('spot-tide-phases').selectedOptions].map((o) => o.value);
  const config = {
    swellMin: num('spot-swell-min', DEFAULT_CRITERIA.swellMin),
    swellMax: num('spot-swell-max', DEFAULT_CRITERIA.swellMax),
    periodMin: num('spot-period-min', DEFAULT_CRITERIA.periodMin),
    windMax: num('spot-wind-max', DEFAULT_CRITERIA.windMax),
    windDirs: selectedDirs.length ? selectedDirs : ['any'],
    tideLeadMin: parseInt($('spot-tide-lead').value, 10) || 0,
    tideStates: [...$('spot-tide-states').selectedOptions].map((o) => o.value),
    tidePhases: selectedPhases,
    coefMin: Math.min(120, Math.max(0, num('spot-coef-min', 0))),
    coefMax: Math.min(120, Math.max(0, num('spot-coef-max', 120))),
  };

  if (state.editingSpotId) {
    const spot = state.spots.find((s) => s.id === state.editingSpotId);
    spot.name = name;
    spot.lat = lat;
    spot.lng = lng;
    spot.config = config;
    state.selectedSpotId = spot.id;
  } else {
    const id = 'spot-' + Date.now().toString(36);
    state.spots.push({ id, name, lat, lng, config });
    state.selectedSpotId = id;
  }
  Storage.saveSpots(state.spots);
  state.editingSpotId = null;
  $('spot-edit-card').style.display = 'none';
  renderSpotsList();
  state.spotsData = {}; // recharger toutes les houles (le spot modifié peut avoir bougé)
  refresh(true);
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
  delete state.spotsData[spotId];
  if (state.selectedSpotId === spotId) {
    state.selectedSpotId = null;
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
    tides: (data.tides || []).map((t) => ({ ...t, time: new Date(t.time) })),
  };
}

function setUpdateLabel(text) {
  $('last-update').textContent = text;
}

// Données marine d'un spot ({marine, fetchedAt}) ou null.
function spotData(spotId) {
  const d = state.spotsData[spotId];
  return d && d.marine && d.marine.length ? d : null;
}

function spotDataValues() {
  const out = [];
  for (const id in state.spotsData) {
    if (state.spotsData[id] && state.spotsData[id].marine && state.spotsData[id].marine.length) {
      out.push(state.spotsData[id]);
    }
  }
  return out;
}

// Heure de prévision la plus proche de maintenant, pour un tableau d'heures.
function nearestHourOf(marine, now) {
  if (!marine || !marine.length) return null;
  let hour = marine[0];
  let best = Infinity;
  for (const h of marine) {
    const d = Math.abs(h.time - now);
    if (d < best) { best = d; hour = h; }
  }
  return best < 3 * 3600 * 1000 ? hour : null;
}

function freshMetar() {
  if (!state.metar || !(state.metar.time instanceof Date)) return null;
  const age = Date.now() - state.metar.time.getTime();
  // Relevé METAR de plus de 3 h : trop ancien pour représenter l'instant présent.
  if (age > 3 * 60 * 60 * 1000) return null;
  return state.metar;
}

// Remplace le vent prévu par le vent observé LFBZ (si relevé récent) :
// le METAR de Biarritz-Anglet vaut pour tous les spots de la commune.
function applyMetar(hour) {
  const metar = freshMetar();
  if (metar && typeof metar.windSpeed === 'number') {
    return { ...hour, windSpeed: metar.windSpeed, gust: metar.gust, windDirection: metar.windDirection };
  }
  return hour;
}

// Libellé marée courant : phase + mi-marée + coefficient.
function tideLabel(ctx) {
  if (!ctx) return '';
  const parts = [ctx.phase === 'rising' ? 'marée montante' : 'marée descendante'];
  if (ctx.midTide) parts.push('mi-marée');
  if (ctx.coefficient !== null && ctx.coefficient !== undefined) parts.push('c.≈' + ctx.coefficient);
  return parts.join(' · ');
}

async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  updateUsageLabel();
  const btn = $('btn-refresh');
  btn.disabled = true;

  try {
    if (state.settings.demoMode) {
      const demo = await fetchDemo();
      const now = new Date();
      state.spots.forEach((s) => {
        state.spotsData[s.id] = { marine: demo.marine, fetchedAt: now, source: 'demo' };
      });
      state.tides = demo.tides;
      setUpdateLabel(`Mis à jour à ${now.toLocaleTimeString('fr-FR')} (mode démo)`);
      render();
      return;
    }

    loadMetar();

    // --- Marées (partagées, 1 requête Stormglass / jour, cache 24 h) ---
    const rawTides = Storage.getTides();
    const now = Date.now();
    const tidesUsable = rawTides
      && rawTides.tides && rawTides.tides.length > 0
      && rawTides.tides.some((t) => new Date(t.time).getTime() > now)
      && now - new Date(rawTides.fetchedAt).getTime() < TIDE_TTL;
    if (tidesUsable) {
      state.tides = rawTides.tides.map((t) => ({ ...t, time: new Date(t.time) }));
    }

    // --- Houle/vent par spot : cache 6 h, sinon fetch en parallèle ---
    const toFetch = [];
    state.spots.forEach((s) => {
      const rawCache = Storage.getLastData(s.id);
      const cached = rawCache && rawCache.source === 'live' ? reviveData(rawCache) : null;
      const fresh = cached && now - cached.fetchedAt.getTime() < MARINE_TTL;
      if (fresh && cached.marine.length) {
        state.spotsData[s.id] = { marine: cached.marine, fetchedAt: cached.fetchedAt, source: 'live' };
      } else {
        toFetch.push(s);
      }
    });

    const needTides = !tidesUsable && (force ? tideRetryAllowed() : true);
    const errors = [];

    if (force || toFetch.length || needTides) {
      const jobs = toFetch.map(async (s) => {
        try {
          const marine = await fetchMarine(s);
          state.spotsData[s.id] = { marine, fetchedAt: new Date(), source: 'live' };
          Storage.saveLastData(s.id, {
            marine: marine.map((h) => ({ ...h, time: h.time.toISOString() })),
            tides: [],
            fetchedAt: new Date().toISOString(),
            source: 'live',
          });
        } catch (err) {
          errors.push(`${s.name} : ${err.message}`);
        }
      });
      if (needTides) {
        jobs.push((async () => {
          try {
            const anchor = state.spots[0];
            const fetched = await fetchTideExtremes(anchor);
            state.tides = fetched;
            Storage.saveTides({ tides: fetched.map((t) => ({ ...t, time: t.time.toISOString() })), fetchedAt: new Date().toISOString() });
          } catch (err) {
            errors.push(`marées : ${err.message}`);
          }
        })());
      }
      await Promise.all(jobs);
    }

    const anyData = spotDataValues().length > 0;
    const parts = [];
    if (anyData) {
      const stamps = spotDataValues().map((d) => d.fetchedAt.getTime());
      const stamp = Math.max.apply(null, stamps);
      parts.push('Données du', new Date(stamp).toLocaleTimeString('fr-FR'));
    } else {
      parts.push('Erreur de chargement');
    }
    if (errors.length) parts.push(errors.join(' · '));
    setUpdateLabel(parts.join(' '));
    updateUsageLabel();
    render();
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
    render();
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
  render();
}

/* ---------- Classement des spots ---------- */

// Évalue chaque spot à l'instant T (relevés en direct + METAR + marée).
function spotRanking() {
  const now = new Date();
  const ctx = tideContextAt(state.tides, now);
  const rows = [];
  for (const s of state.spots) {
    const sd = spotData(s.id);
    const hour = sd ? nearestHourOf(sd.marine, now) : null;
    if (!hour) continue;
    const h = applyMetar(hour);
    const { ok, checks } = matchesCriteria(h, s.config, ctx);
    rows.push({
      spot: s,
      hour: h,
      ok,
      checks,
      score: scoreChecks(checks),
      ctx,
    });
  }
  // Meilleurs d'abord : GO avant NO GO, puis nb de critères réunis, puis vent le plus faible.
  rows.sort((a, b) => ((b.ok ? 1 : 0) - (a.ok ? 1 : 0))
    || (b.score - a.score)
    || ((a.hour.windSpeed || 0) - (b.hour.windSpeed || 0)));
  return rows;
}

function renderRanking() {
  const el = $('spot-ranking');
  if (!el) return;
  const rows = spotRanking();
  if (rows.length === 0) {
    el.innerHTML = '<li class="hint">Relevés indisponibles pour le moment.</li>';
    return;
  }
  // Spot affiché par défaut : le meilleur du classement.
  if (!state.selectedSpotId || !state.spots.some((s) => s.id === state.selectedSpotId)) {
    state.selectedSpotId = rows[0].spot.id;
  }
  el.innerHTML = rows.map((r, i) => {
    const tideTxt = tideLabel(r.ctx);
    return `<li class="rank-row${r.spot.id === state.selectedSpotId ? ' selected' : ''}" data-rank="${r.spot.id}">
      <span class="rank-num ${r.ok ? 'good' : 'bad'}">${i + 1}</span>
      <div class="rank-info">
        <div class="spot-name">${escapeHtml(r.spot.name)}
          <span class="badge ${r.ok ? 'good' : 'bad'}">${r.ok ? 'GO' : 'NO GO'}</span>
        </div>
        <div class="spot-coords">houle ${fmt(r.hour.swellHeight, 1)} m · ${fmt(r.hour.swellPeriod, 0)} s · vent ${fmt(r.hour.windSpeed, 0)} km/h ${degToDir(r.hour.windDirection)}${tideTxt ? ' · ' + tideTxt : ''}</div>
      </div>
    </li>`;
  }).join('');
  el.querySelectorAll('[data-rank]').forEach((li) => {
    li.addEventListener('click', () => {
      state.selectedSpotId = li.dataset.rank;
      render();
    });
  });
}

// Meilleur spot de l'instant T à 48 h, d'après les prévisions.
function renderBest48h() {
  const el = $('best-48h');
  if (!el) return;
  const scored = [];
  for (const s of state.spots) {
    const sd = spotData(s.id);
    if (!sd) continue;
    const windows = findFavorableWindows(sd.marine, s.config, state.tides)
      .filter((w) => w.end.getTime() > Date.now());
    const hours = windows.reduce((n, w) => n + w.hours.length, 0);
    scored.push({ spot: s, windows, hours });
  }
  if (scored.length === 0) {
    el.innerHTML = '<p class="hint">Prévisions indisponibles pour le moment.</p>';
    return;
  }
  scored.sort((a, b) => b.hours - a.hours);
  const best = scored[0];
  let html = `<div class="best48-main">${best.hours > 0
    ? `🏄 <strong>${escapeHtml(best.spot.name)}</strong> — ${best.hours} h favorables dans les 48 h`
    : `Aucun spot favorable dans les 48 h avec vos critères`}</div>`;
  html += '<ul class="best48-list">';
  for (const r of scored) {
    const next = r.windows.find((w) => w.end.getTime() > Date.now());
    html += `<li data-rank48="${r.spot.id}">
      <span>${escapeHtml(r.spot.name)}</span>
      <span class="badge ${r.hours > 0 ? 'good' : 'bad'}">${r.hours} h${next ? ' · dès ' + rangeLabel(next.start) : ''}</span>
    </li>`;
  }
  html += '</ul>';
  el.innerHTML = html;
  el.querySelectorAll('[data-rank48]').forEach((li) => {
    li.addEventListener('click', () => {
      state.selectedSpotId = li.dataset.rank48;
      render();
    });
  });
}

/* ---------- Rendu (spot affiché) ---------- */

function focusSpot() {
  return state.spots.find((s) => s.id === state.selectedSpotId) || state.spots[0] || null;
}

function render() {
  renderRanking();
  renderBest48h();
  renderFocus();
  renderTides();
  renderForecast();
  renderWindows();
  renderFocusCriteria();
  updateSessionConditionsHint();
  if (spotsMap) renderSpotsMap();
  checkAlerts();
}

function renderFocusCriteria() {
  const el = $('focus-criteria');
  if (!el) return;
  const spot = focusSpot();
  if (!spot) { el.textContent = '—'; return; }
  el.innerHTML = `<strong>${escapeHtml(spot.name)}</strong> : ${describeConfigTxt(spot.config)}`
    + ' — pour modifier ces critères, rendez-vous dans l\'onglet <strong>Spots</strong> ou « Vos conditions gagnantes » (Sessions).';
}

// Version locale de describeConfig (sans dépendance circulaire).
function describeConfigTxt(c) {
  const dirs = c.windDirs.includes('any') || c.windDirs.length === 0 ? 'tous secteurs' : c.windDirs.join(', ');
  const out = [
    `houle ${c.swellMin}–${c.swellMax} m`,
    `période ≥ ${c.periodMin} s`,
    `vent ≤ ${c.windMax} km/h (${dirs})`,
  ];
  const phases = c.tidePhases || [];
  const tideLabels = [];
  if (phases.indexOf('rising') !== -1) tideLabels.push('montante');
  if (phases.indexOf('falling') !== -1) tideLabels.push('descendante');
  if (phases.indexOf('mid') !== -1) tideLabels.push('mi-marée');
  if (tideLabels.length) out.push('marée ' + tideLabels.join('/'));
  const cMin = typeof c.coefMin === 'number' ? c.coefMin : 0;
  const cMax = typeof c.coefMax === 'number' ? c.coefMax : 120;
  if (cMin > 0 || cMax < 120) out.push(`coef. ${cMin}–${cMax}`);
  return out.join(' · ');
}

function renderFocus() {
  const container = $('current-cards');
  if (!container) return;
  const spot = focusSpot();
  const sd = spot ? spotData(spot.id) : null;
  if (!spot || !sd) {
    container.innerHTML = '<p class="hint">Chargement des relevés…</p>';
    return;
  }
  const now = new Date();
  let hour = nearestHourOf(sd.marine, now);
  if (!hour) {
    container.innerHTML = '<p class="hint">Relevés indisponibles pour ce spot.</p>';
    return;
  }
  hour = applyMetar(hour);
  const ctx = tideContextAt(state.tides, now);
  const { ok, checks } = matchesCriteria(hour, spot.config, ctx);
  const nextTide = state.tides.find((t) => t.time > now);
  const nextCoef = nextTide ? tideCoefficient(state.tides, state.tides.indexOf(nextTide)) : null;
  // Grand verdict GO / NO GO en tête d'écran (pour le spot affiché)
  const failed = [];
  if (!checks.swell) failed.push('houle');
  if (!checks.period) failed.push('période');
  if (!checks.wind) failed.push('vent');
  if (!checks.windDir) failed.push('secteur');
  if (checks.tidePhase === false) failed.push('marée');
  if (checks.coef === false) failed.push('coefficient');
  const verdict = '<div class="verdict-banner ' + (ok ? 'go' : 'nogo') + '">'
    + '<div class="main">' + (ok ? 'GO 🏄 — conditions favorables' : 'NO GO ⛔ — conditions non réunies') + '</div>'
    + '<div class="sub">' + escapeHtml(spot.name)
    + (ok ? ' — tous vos critères sont réunis' : ' — hors critères : ' + failed.join(', '))
    + '</div></div>';
  const nextTideTxt = nextTide
    ? `${nextTide.type === 'high' ? 'Haute' : 'Basse'} à ${nextTide.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    : '—';
  let tideDetail = '';
  const ctxTxt = tideLabel(ctx);
  if (ctxTxt) tideDetail += ctxTxt;
  if (nextCoef !== null && nextCoef !== undefined) {
    tideDetail += (tideDetail ? ' · ' : '') + `prochain coef. ≈ ${nextCoef}`;
  }
  const metar = freshMetar();
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
    metric('Marée', nextTideTxt, tideDetail, null),
  ];
  container.innerHTML = verdict + cards.join('');
}

function metarCard() {
  if (!state.settings.metarRelay) return '';
  if (state.metarError) {
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
  renderTideChart($('tide-chart'), state.tides, new Date());
}

function renderForecast() {
  const spot = focusSpot();
  const sd = spot ? spotData(spot.id) : null;
  if (!spot || !sd) {
    renderSwellChart($('swell-chart'), [], DEFAULT_CRITERIA, null);
    const tbody = $('forecast-table').querySelector('tbody');
    tbody.innerHTML = '';
    return;
  }
  renderSwellChart($('swell-chart'), sd.marine, spot.config, state.tides);
  const tbody = $('forecast-table').querySelector('tbody');
  tbody.innerHTML = sd.marine
    .filter((_, i) => i % 2 === 0)
    .slice(0, 24)
    .map((h) => {
      const ctx = tideContextAt(state.tides, h.time);
      const { ok } = matchesCriteria(h, spot.config, ctx);
      const nextTide = state.tides.find((t) => Math.abs(t.time - h.time) < 30 * 60 * 1000);
      return `<tr class="${ok ? 'favorable' : ''}">
        <td>${h.time.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${fmt(h.swellHeight, 1)} m</td>
        <td>${fmt(h.swellPeriod, 0)} s</td>
        <td>${fmt(h.windSpeed, 0)} km/h</td>
        <td>${degToDir(h.windDirection)}</td>
        <td>${nextTide ? (nextTide.type === 'high' ? 'haute · c.' + (tideCoefficient(state.tides, state.tides.indexOf(nextTide)) || '—') : 'basse') : ''}</td>
      </tr>`;
    }).join('');
}

function renderWindows() {
  const spot = focusSpot();
  const sd = spot ? spotData(spot.id) : null;
  const labelEl = $('windows-spot');
  if (labelEl) labelEl.textContent = spot ? 'Critères : ' + describeConfigTxt(spot.config) : '';
  const list = $('windows-list');
  if (!spot || !sd) {
    list.innerHTML = '<li class="hint">Données indisponibles.</li>';
    return;
  }
  const windows = findFavorableWindows(sd.marine, spot.config, state.tides)
    .filter((w) => w.end.getTime() > Date.now());
  list.innerHTML = windows.length
    ? windows.map((w) => `<li>
        <span>${rangeLabel(w.start, w.end)}</span>
        <span class="badge good">${w.hours.length} h</span>
      </li>`).join('')
    : '<li class="hint">Aucune fenêtre favorable dans les 48 h avec vos critères.</li>';
}

function rangeLabel(start, end) {
  const f = (d) => d.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return end === undefined ? f(start) : (start.getTime() === end.getTime() ? f(start) : `${f(start)} → ${f(end)}`);
}

function checkAlerts() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const now = new Date();
  const bodyParts = [];
  for (const spot of state.spots) {
    const sd = spotData(spot.id);
    if (!sd) continue;
    const hour = nearestHourOf(sd.marine, now);
    if (!hour) continue;
    const evalHour = applyMetar(hour);
    const ctx = tideContextAt(state.tides, now);
    const { ok } = matchesCriteria(evalHour, spot.config, ctx);
    if (ok) {
      bodyParts.push(
        `${spot.name} : conditions favorables — houle ${fmt(evalHour.swellHeight, 1)} m, ` +
        `vent ${fmt(evalHour.windSpeed, 0)} km/h (${degToDir(evalHour.windDirection)}).`
      );
    }
    for (const t of upcomingTideAlerts(state.tides, spot.config, now)) {
      bodyParts.push(
        `${spot.name} : ${t.type === 'high' ? 'marée haute' : 'marée basse'} dans ${t.minutesAway} min (${fmt(t.height, 1)} m).`
      );
    }
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

// --- Carte des spots (Leaflet + OpenStreetMap, sans clé API) ---

function renderSpotsMap() {
  const el = $('spots-map');
  if (!el) return;
  if (typeof L === 'undefined') {
    el.innerHTML = '<p class="hint">Carte indisponible : connexion requise au premier chargement.</p>';
    return;
  }
  if (!spotsMap) {
    spotsMap = L.map(el, { scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap',
    }).addTo(spotsMap);
  }
  Object.keys(spotMarkers).forEach((id) => { spotsMap.removeLayer(spotMarkers[id]); });
  spotMarkers = {};
  const ranked = spotRanking();
  const rankOf = {};
  ranked.forEach((r, i) => { rankOf[r.spot.id] = i; });
  const bounds = [];
  state.spots.forEach((s) => {
    const rank = rankOf[s.id];
    const r = typeof rank === 'number' ? ranked[rank] : null;
    const ok = r ? r.ok : null;
    const color = ok === null ? '#6b7c86' : (ok ? '#1d8a4e' : '#b03a3a');
    const marker = L.circleMarker([s.lat, s.lng], {
      radius: rank === 0 ? 12 : 8,
      color: '#ffffff',
      weight: 2,
      fillColor: color,
      fillOpacity: 0.95,
    }).addTo(spotsMap);
    marker.bindTooltip(s.name
      + (ok === null ? '' : (ok ? ' — favorable 🏄' : ' — hors critères')));
    marker.on('click', () => {
      state.selectedSpotId = s.id;
      render();
    });
    spotMarkers[s.id] = marker;
    bounds.push([s.lat, s.lng]);
  });
  if (bounds.length === 1) {
    spotsMap.setView(bounds[0], 14);
  } else if (bounds.length) {
    spotsMap.fitBounds(bounds, { padding: [28, 28] });
  }
}

/* ---------- Onglet Sessions ---------- */

function renderSessionSpotSelect() {
  const sel = $('session-spot');
  if (!sel) return;
  const current = state.selectedSpotId;
  sel.innerHTML = state.spots
    .map((s) => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
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
  // Session « instant T » : spot + un appui → données actuelles capturées automatiquement.
  $('btn-instant-session').addEventListener('click', async () => {
    const btn = $('btn-instant-session');
    btn.disabled = true;
    btn.textContent = '⚡ Mesure en cours…';
    try { await refresh(true); } catch (e) { /* on capture avec les données disponibles */ }
    const spot = sessionSpot();
    const when = new Date();
    const ratingVal = $('session-rating').value;
    const session = {
      id: 's' + Date.now(),
      date: when.toISOString(),
      spotId: spot.id,
      spotName: spot.name,
      rating: ratingVal ? parseInt(ratingVal, 10) : null,
      notes: $('session-notes').value.trim(),
      conditions: syncSnapshotFromMarine(when, spot.id)
        || (sessionSnapshotCache ? sessionSnapshotCache.snapshot : null),
    };
    state.sessions = [session].concat(state.sessions);
    Storage.saveSessions(state.sessions);
    $('session-notes').value = '';
    $('session-rating').value = '';
    setNow();
    renderSessionsList();
    btn.disabled = false;
    btn.textContent = '⚡ Session instant T';
  });
  $('btn-save-session').addEventListener('click', () => {
    const spot = sessionSpot();
    const when = dateInput.value ? new Date(dateInput.value) : new Date();
    const ratingVal = $('session-rating').value;
    const session = {
      id: 's' + Date.now(),
      date: when.toISOString(),
      spotId: spot.id,
      spotName: spot.name,
      rating: ratingVal ? parseInt(ratingVal, 10) : null,
      notes: $('session-notes').value.trim(),
      conditions: snapshotFor(when, spot.id),
    };
    state.sessions = [session].concat(state.sessions);
    Storage.saveSessions(state.sessions);
    $('session-notes').value = '';
    $('session-rating').value = '';
    setNow();
    renderSessionsList();
  });
  renderSessionsList();
}

function sessionSpot() {
  const sel = $('session-spot');
  return state.spots.find((s) => s.id === sel.value) || state.spots[0];
}

async function loadSessionConditions() {
  const dateInput = $('session-date');
  if (!dateInput || !dateInput.value) return;
  const when = new Date(dateInput.value);
  const spot = sessionSpot();
  const near = syncSnapshotFromMarine(when, spot.id);
  if (near) {
    sessionSnapshotCache = { when: when.getTime(), snapshot: near };
    updateSessionConditionsHint(when);
    return;
  }
  const el = $('session-conditions');
  el.textContent = 'Recherche des conditions du ' + when.toLocaleString('fr-FR') + '…';
  try {
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

function snapshotFor(when, spotId) {
  const near = syncSnapshotFromMarine(when, spotId);
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

function syncSnapshotFromMarine(when, spotId) {
  const spot = spotId ? state.spots.find((s) => s.id === spotId) : null;
  const sd = spot ? spotData(spot.id) : spotDataValues()[0];
  if (!sd) return null;
  let hour = sd.marine[0];
  let best = Infinity;
  for (const h of sd.marine) {
    const d = Math.abs(h.time - when);
    if (d < best) { best = d; hour = h; }
  }
  if (best > 3 * 3600 * 1000) return null;
  const h = spotId ? applyMetar(hour) : hour;
  const parts = [
    'houle ' + fmt(h.swellHeight, 1) + ' m',
    fmt(h.swellPeriod, 0) + ' s',
    'vent ' + fmt(h.windSpeed, 0) + ' km/h ' + degToDir(h.windDirection),
  ];
  if (h.gust) parts.push('rafales ' + fmt(h.gust, 0));
  const ctx = tideContextAt(state.tides, when);
  if (ctx) parts.push(tideLabel(ctx));
  return {
    text: parts.join(' · '),
    swellHeight: typeof h.swellHeight === 'number' ? h.swellHeight : null,
    swellPeriod: typeof h.swellPeriod === 'number' ? h.swellPeriod : null,
    windSpeed: typeof h.windSpeed === 'number' ? h.windSpeed : null,
  };
}

function updateSessionConditionsHint(when) {
  const el = $('session-conditions');
  if (!el) return;
  const w = when || new Date();
  const spot = sessionSpot();
  const snap = syncSnapshotFromMarine(w, spot.id);
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
  } else {
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
  }
  renderSessionsAnalysis();
}

// Conditions gagnantes PAR SPOT, déduites des sessions notées ★★★★ / ★★★★★.
function renderSessionsAnalysis() {
  const el = $('sessions-analysis');
  if (!el) return;
  // Regroupe les sessions notées par spot.
  const bySpot = {};
  for (const s of state.sessions || []) {
    if (!s.rating || s.rating < 4) continue;
    if (!s.conditions || typeof s.conditions.swellHeight !== 'number' || typeof s.conditions.windSpeed !== 'number') continue;
    if (!bySpot[s.spotId]) bySpot[s.spotId] = [];
    bySpot[s.spotId].push(s);
  }
  const spotIds = Object.keys(bySpot);
  if (spotIds.length === 0) {
    el.innerHTML = '<p class="hint">Enregistrez au moins 2 sessions notées ★★★★ ou ★★★★★ par spot : l\'app en déduira automatiquement vos conditions gagnantes pour chaque spot.</p>';
    return;
  }
  const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
  let html = '';
  for (const spotId of spotIds) {
    const list = bySpot[spotId];
    const spot = state.spots.find((s) => s.id === spotId);
    const name = spot ? spot.name : (list[0].spotName || 'Spot');
    const swell = list.map((s) => s.conditions.swellHeight).sort((a, b) => a - b);
    const period = list.map((s) => s.conditions.swellPeriod).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    const wind = list.map((s) => s.conditions.windSpeed).sort((a, b) => a - b);
    const cri = {
      swellMin: Math.round(swell[0] * 10) / 10,
      swellMax: Math.round(swell[swell.length - 1] * 10) / 10,
      periodMin: period.length ? Math.round(median(period)) : null,
      windMax: wind.length ? Math.round(wind[wind.length - 1] + 2) : null,
    };
    let txt = `houle <strong>${cri.swellMin}–${cri.swellMax} m</strong>`;
    if (cri.periodMin) txt += ` · période ≥ <strong>${cri.periodMin} s</strong>`;
    if (cri.windMax) txt += ` · vent ≤ <strong>${cri.windMax} km/h</strong>`;
    html += `<div class="analysis-item">
      <div class="spot-name">${escapeHtml(name)} <span class="spot-coords">(${list.length} session${list.length > 1 ? 's' : ''})</span></div>
      <p class="hint">D'après vos ${list.length} meilleures sessions : ${txt}.</p>
      <button class="primary" data-apply-cri="${spotId}">Appliquer à ce spot ✓</button>
    </div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('[data-apply-cri]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const spotId = btn.dataset.applyCri;
      const spot = state.spots.find((s) => s.id === spotId);
      const sessions = bySpot[spotId];
      const swell = sessions.map((s) => s.conditions.swellHeight).sort((a, b) => a - b);
      const period = sessions.map((s) => s.conditions.swellPeriod).filter((v) => typeof v === 'number').sort((a, b) => a - b);
      const wind = sessions.map((s) => s.conditions.windSpeed).sort((a, b) => a - b);
      const cfg = spot.config;
      if (swell.length) {
        cfg.swellMin = Math.round(swell[0] * 10) / 10;
        cfg.swellMax = Math.round(swell[swell.length - 1] * 10) / 10;
      }
      if (period.length) cfg.periodMin = Math.round(median(period));
      if (wind.length) cfg.windMax = Math.round(wind[wind.length - 1] + 2);
      Storage.saveSpots(state.spots);
      btn.textContent = 'Appliqué ✓';
      renderSessionsAnalysis();
      renderSpotsList();
      render();
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
