const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function degToDir(deg) {
  if (typeof deg !== 'number' || Number.isNaN(deg)) return '—';
  return DIRS[Math.round(((deg % 360) / 45)) % 8];
}

function windDirAllowed(deg, allowed) {
  if (!allowed || allowed.length === 0 || allowed.includes('any')) return true;
  return allowed.includes(degToDir(deg));
}

export function matchesCriteria(hour, config) {
  const checks = {
    swell:
      hour.swellHeight >= config.swellMin &&
      hour.swellHeight <= config.swellMax,
    period: hour.swellPeriod >= config.periodMin,
    wind: hour.windSpeed <= config.windMax,
    windDir: windDirAllowed(hour.windDirection, config.windDirs),
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

export function findFavorableWindows(marine, config) {
  const windows = [];
  let current = null;
  for (const hour of marine) {
    const { ok } = matchesCriteria(hour, config);
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
    .filter((t) => config.tideStates.includes(t.type))
    .map((t) => ({ ...t, minutesAway: Math.round((t.time - now) / 60000) }))
    .filter((t) => t.minutesAway >= 0 && t.minutesAway <= config.tideLeadMin);
}

export function describeConfig(config) {
  const dirs = config.windDirs.includes('any') || config.windDirs.length === 0
    ? 'tous secteurs'
    : config.windDirs.join(', ');
  return [
    `Houle ${config.swellMin}–${config.swellMax} m`,
    `période ≥ ${config.periodMin} s`,
    `vent ≤ ${config.windMax} km/h (${dirs})`,
  ].join(' · ');
}
