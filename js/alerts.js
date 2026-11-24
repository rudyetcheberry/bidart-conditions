const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function degToDir(deg) {
  if (typeof deg !== 'number' || Number.isNaN(deg)) return '\u2014';
  return DIRS[Math.round(((deg % 360) / 45)) % 8];
}

// Unité de coefficient (Boucau-Bayonne) : C = marnage / U × 100.
// Calibration = marnage au coef 100 : 3,79 m (maree.info/SHOM ; maxima
// 4,49 m ≈ coef 118, cohérent). Même valeur que dans chart.js (TIDE_UNIT).
// Le coefficient SHOM est borné à [20 ; 120].
const TIDE_UNIT = 3.79;
const clampCoef = function (c) { return Math.max(20, Math.min(120, c)); };

function windDirAllowed(deg, allowed) {
  if (!allowed || allowed.length === 0 || allowed.includes('any')) return true;
  return allowed.includes(degToDir(deg));
}

// Contexte de marée à un instant donné : phase (montante/descendante),
// mi-marée (dans la partie médiane entre deux extrêmes) et coefficient.
export function tideContextAt(tides, when) {
  if (!Array.isArray(tides) || tides.length < 2) return null;
  const sorted = tides.slice().sort((a, b) => a.time - b.time);
  const t = when.getTime();
  let e1 = null;
  let e2 = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i].time.getTime();
    const b = sorted[i + 1].time.getTime();
    if (t >= a && t <= b) { e1 = sorted[i]; e2 = sorted[i + 1]; break; }
  }
  if (!e1 || !e2 || typeof e1.height !== 'number' || typeof e2.height !== 'number') return null;
  const span = e2.time.getTime() - e1.time.getTime();
  const frac = span > 0 ? (t - e1.time.getTime()) / span : 0.5;
  return {
    phase: e1.type === 'low' ? 'rising' : 'falling',
    // Mi-marée : on considère la partie centrale de la mi-marée (±20 % de la durée).
    midTide: frac >= 0.4 && frac <= 0.6,
    frac,
    coefficient: clampCoef(Math.round((Math.abs(e2.height - e1.height) / TIDE_UNIT) * 100)),
  };
}

// hour : donnée marine d'une heure · config : critères du spot ·
// ctx : contexte de marée (tideContextAt) — facultatif (critères de marée
// neutres si absent, ex. points du graphique de houle).
export function matchesCriteria(hour, config, ctx) {
  const checks = {
    swell:
      hour.swellHeight >= config.swellMin &&
      hour.swellHeight <= config.swellMax,
    period: hour.swellPeriod >= config.periodMin,
    wind: hour.windSpeed <= config.windMax,
    windDir: windDirAllowed(hour.windDirection, config.windDirs),
  };
  if (ctx) {
    // Phase de marée désirée (montante / descendante / mi-marée)
    if (config.tidePhases && config.tidePhases.length > 0) {
      checks.tidePhase = (config.tidePhases.indexOf(ctx.phase) !== -1) ||
        (config.tidePhases.indexOf('mid') !== -1 && ctx.midTide);
    }
    // Plage de coefficient (rectifiée entre 0 et 120)
    const cMin = typeof config.coefMin === 'number' ? config.coefMin : 0;
    const cMax = typeof config.coefMax === 'number' ? config.coefMax : 120;
    if (cMin > 0 || cMax < 120) {
      checks.coef = ctx.coefficient !== null && ctx.coefficient !== undefined
        ? ctx.coefficient >= cMin && ctx.coefficient <= cMax
        : true; // pas de données de marée : critère neutre
    }
  }
  let ok = true;
  for (const k in checks) {
    if (!checks[k]) ok = false;
  }
  return { ok, checks };
}

// Nombre de critères réunis (pour classer les spots).
export function scoreChecks(checks) {
  let n = 0;
  for (const k in checks) {
    if (checks[k]) n += 1;
  }
  return n;
}

export function findFavorableWindows(marine, config, tides) {
  const windows = [];
  let current = null;
  for (const hour of marine) {
    const ctx = tideContextAt(tides, hour.time);
    const { ok } = matchesCriteria(hour, config, ctx);
    if (ok) {
      if (!current) {
        current = { start: hour.time, end: hour.time, hours: [] };
        windows.push(current);
      }
      current.end = hour.time;
      current.hours.push(hour);
    } else {
      current = null;
    }
  }
  return windows;
}

export function upcomingTideAlerts(tides, config, now = new Date()) {
  if (!config.tideLeadMin || config.tideStates.length === 0) return [];
  return tides
    .filter((t) => config.tideStates.indexOf(t.type) !== -1)
    .map((t) => ({ ...t, minutesAway: Math.round((t.time - now) / 60000) }))
    .filter((t) => t.minutesAway >= 0 && t.minutesAway <= config.tideLeadMin);
}

function describeTideCriteria(config) {
  const parts = [];
  if (config.tidePhases && config.tidePhases.length > 0) {
    const labels = [];
    if (config.tidePhases.indexOf('rising') !== -1) labels.push('montante');
    if (config.tidePhases.indexOf('falling') !== -1) labels.push('descendante');
    if (config.tidePhases.indexOf('mid') !== -1) labels.push('mi-marée');
    if (labels.length) parts.push('marée ' + labels.join('/'));
  }
  const cMin = typeof config.coefMin === 'number' ? config.coefMin : 0;
  const cMax = typeof config.coefMax === 'number' ? config.coefMax : 120;
  if (cMin > 0 || cMax < 120) parts.push('coef. ' + cMin + '\u2013' + cMax);
  return parts.join(', ');
}

export function describeConfig(config) {
  const dirs = config.windDirs.includes('any') || config.windDirs.length === 0
    ? 'tous secteurs'
    : config.windDirs.join(', ');
  const out = [
    `Houle ${config.swellMin}\u2013${config.swellMax} m`,
    `période ≥ ${config.periodMin} s`,
    `vent ≤ ${config.windMax} km/h (${dirs})`,
  ];
  const tide = describeTideCriteria(config);
  if (tide) out.push(tide);
  return out.join(' · ');
}
