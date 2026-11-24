import { matchesCriteria, tideContextAt } from './alerts.js';

// Couleurs adaptées au thème (mode nuit = classe .night sur <body>).
function themeColors() {
  const night = typeof document !== 'undefined' && document.body && document.body.classList.contains('night');
  return night
    ? { grid: '#25455a', label: '#8fa8b5', mark: '#c8d8e0', area: '#3ba7db', line: '#3ba7db' }
    : { grid: '#e6edf1', label: '#6b7c86', mark: '#3d4f59', area: '#0e7fb0', line: '#0e7fb0' };
}

const W = 660;
const H = 240;
const PAD_L = 42;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 30;

// Unité de hauteur (m) pour Boucau-Bayonne / Biarritz, port SHOM de référence.
// Calibration = marnage au coefficient 100 : maree.info/SHOM affiche 3,79 m
// pour Boucau-Bayonne (maxima 4,49 m ≈ coef 118 ; 3,79 × 1,18 = 4,47 ✓).
// Le coefficient SHOM est national (calculé pour Brest, U = 6,10 m) ; le
// marnage local au coef 100, lui, vaut 3,79 m à Boucau-Bayonne.
export const TIDE_UNIT = 3.79;

// Coefficient de marée (20–120) d'un extrême, calculé à partir du marnage
// avec l'extrême opposé voisin (formule C = marnage / U × 100).
export function tideCoefficient(tides, idx) {
  const t = tides[idx];
  if (!t || typeof t.height !== 'number') return null;
  let other = null;
  if (t.type === 'high') {
    other = tides[idx + 1] && tides[idx + 1].type === 'low' ? tides[idx + 1] : tides[idx - 1];
  } else {
    other = tides[idx - 1] && tides[idx - 1].type === 'high' ? tides[idx - 1] : tides[idx + 1];
  }
  if (!other || typeof other.height !== 'number') return null;
  // Bornage SHOM : le coefficient officiel est compris entre 20 et 120.
  const c = Math.round((Math.abs(t.height - other.height) / TIDE_UNIT) * 100);
  return Math.max(20, Math.min(120, c));
}

// tides (facultatif) : extrêmes Stormglass pour évaluer les critères de marée
// (phase, coefficient) sur les points de prévision.
export function renderSwellChart(container, marine, config, tides) {
  if (!container) return;
  const C = themeColors();
  const pts = marine.filter((h) => typeof h.swellHeight === 'number');
  if (pts.length < 2) {
    container.innerHTML = '<p class="hint">Données de houle indisponibles.</p>';
    return;
  }

  const t0 = pts[0].time.getTime();
  const t1 = pts[pts.length - 1].time.getTime();
  const maxV = Math.max(config.swellMax, ...pts.map((p) => p.swellHeight)) * 1.15;
  const x = (t) => PAD_L + ((t - t0) / (t1 - t0)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - v / maxV) * (H - PAD_T - PAD_B);

  // --- Vent (échelle de droite, en orange) ---
  const windPts = pts.filter((p) => typeof p.windSpeed === 'number');
  const hasWind = windPts.length >= 2;
  const maxWind = hasWind ? Math.max(config.windMax, ...windPts.map((p) => p.windSpeed)) * 1.15 : 0;
  const yw = (v) => PAD_T + (1 - v / maxWind) * (H - PAD_T - PAD_B);
  const windLine = hasWind
    ? windPts.map((p, i) => `${i ? 'L' : 'M'}${x(p.time.getTime()).toFixed(1)},${yw(p.windSpeed).toFixed(1)}`).join(' ')
    : '';
  // Axe de droite : graduations du vent
  let windAxis = '';
  if (hasWind) {
    const stepW = maxWind > 60 ? 20 : maxWind > 30 ? 10 : 5;
    for (let v = 0; v <= maxWind; v += stepW) {
      windAxis += `<line x1="${W - PAD_R - 4}" y1="${yw(v).toFixed(1)}" x2="${W - PAD_R}" y2="${yw(v).toFixed(1)}" stroke="#d0782a" stroke-width="1"/>`
        + `<text x="${W - PAD_R + 3}" y="${(yw(v) + 3).toFixed(1)}" text-anchor="start" font-size="9" fill="#d0782a">${v}</text>`;
    }
    // Limite de vent max du spot (repère vert pointillé sur l'échelle du vent)
    if (config.windMax < maxWind) {
      windAxis += `<line x1="${PAD_L}" y1="${yw(config.windMax).toFixed(1)}" x2="${W - PAD_R}" y2="${yw(config.windMax).toFixed(1)}" stroke="#1d8a4e" stroke-width="1" stroke-dasharray="3 4"/>`
        + `<text x="${W - PAD_R - 6}" y="${(yw(config.windMax) - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="#1d8a4e">vent max</text>`;
    }
  }

  const line = pts
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.time.getTime()).toFixed(1)},${y(p.swellHeight).toFixed(1)}`)
    .join(' ');
  const baseY = (H - PAD_B).toFixed(1);
  const area = `${line} L${x(t1).toFixed(1)},${baseY} L${x(t0).toFixed(1)},${baseY} Z`;

  const step = maxV > 6 ? 2 : maxV > 3 ? 1 : 0.5;
  let grid = '';
  for (let v = 0; v <= maxV; v += step) {
    grid += `<line x1="${PAD_L}" y1="${y(v).toFixed(1)}" x2="${W - PAD_R}" y2="${y(v).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`
      + `<text x="${PAD_L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.label}">${v.toFixed(1)}</text>`;
  }

  let xlabels = '';
  pts.forEach((p) => {
    const hourIndex = Math.round((p.time.getTime() - t0) / 3600000);
    if (hourIndex % 6 === 0) {
      const day = p.time.toLocaleDateString('fr-FR', { weekday: 'short' });
      const hour = p.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      xlabels += `<text x="${x(p.time.getTime()).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="${C.label}">${day} ${hour}</text>`;
    }
  });

  const bandTop = y(Math.min(config.swellMax, maxV)).toFixed(1);
  const bandBottom = y(config.swellMin).toFixed(1);
  const band = `<rect x="${PAD_L}" y="${bandTop}" width="${W - PAD_L - PAD_R}" height="${(bandBottom - bandTop).toFixed(1)}" fill="#1d8a4e" opacity="0.12"/>`;

  const dots = pts.map((p) => {
    const ctx = tideContextAt(tides, p.time);
    const { ok } = matchesCriteria(p, config, ctx);
    const period = typeof p.swellPeriod === 'number' ? `${p.swellPeriod} s` : '—';
    const wind = typeof p.windSpeed === 'number' ? ` · vent ${p.windSpeed} km/h` : '';
    return `<circle cx="${x(p.time.getTime()).toFixed(1)}" cy="${y(p.swellHeight).toFixed(1)}" r="3" fill="${ok ? '#1d8a4e' : '#b03a3a'}">`
      + `<title>${p.time.toLocaleString('fr-FR')} — ${p.swellHeight.toFixed(1)} m · ${period}${wind}</title></circle>`;
  }).join('');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Courbes de houle et de vent sur 48 heures">
    ${band}${grid}${xlabels}${windAxis}
    <path d="${area}" fill="${C.area}" opacity="0.15"/>
    <path d="${line}" fill="none" stroke="${C.line}" stroke-width="2.5" stroke-linejoin="round"/>
    ${hasWind ? `<path d="${windLine}" fill="none" stroke="#d0782a" stroke-width="2" stroke-dasharray="6 3" stroke-linejoin="round"/>` : ''}
    ${dots}
  </svg>`;
}

// Courbe de marée sur ~24 h, interpolée (cosinus) entre les extrêmes Stormglass.
export function renderTideChart(container, tides, now) {
  if (!container) return;
  const C = themeColors();
  const hint = '<p class="hint">Courbe de marée indisponible : clé Stormglass ou quota requis. Le bouton ↻ réessaie.</p>';
  if (!tides || tides.length < 2) { container.innerHTML = hint; return; }
  const sorted = tides.slice().sort((a, b) => a.time - b.time);
  const start = now.getTime() - 3 * 3600000;
  const end = now.getTime() + 24 * 3600000;
  const usable = sorted.filter((t) => t.time.getTime() >= start - 13 * 3600000 && t.time.getTime() <= end + 13 * 3600000);
  if (usable.length < 2) { container.innerHTML = hint; return; }

  // Échantillonnage : entre deux extrêmes consécutifs, la hauteur suit un cosinus.
  const samples = [];
  for (let i = 0; i < usable.length - 1; i++) {
    const e1 = usable[i];
    const e2 = usable[i + 1];
    const t1 = e1.time.getTime();
    const t2 = e2.time.getTime();
    const segStart = Math.max(t1, start);
    const segEnd = Math.min(t2, end);
    if (segEnd <= segStart) continue;
    for (let t = segStart; t <= segEnd; t += 10 * 60 * 1000) {
      const frac = (t - t1) / (t2 - t1);
      const h = (e1.height + e2.height) / 2 + (e1.height - e2.height) / 2 * Math.cos(Math.PI * frac);
      samples.push({ t: t, h: h });
    }
  }
  if (samples.length < 2) { container.innerHTML = hint; return; }

  const heights = samples.map((s) => s.h).concat(usable.map((u) => u.height));
  const yMin = Math.min.apply(null, heights) - 0.25;
  const yMax = Math.max.apply(null, heights) + 0.25;
  const x = (t) => PAD_L + ((t - start) / (end - start)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD_T - PAD_B);

  const line = samples
    .map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.h).toFixed(1)}`)
    .join(' ');
  const baseY = (H - PAD_B).toFixed(1);
  const area = `${line} L${x(samples[samples.length - 1].t).toFixed(1)},${baseY} L${x(samples[0].t).toFixed(1)},${baseY} Z`;

  const range = yMax - yMin;
  const stepY = range > 4 ? 1 : range > 2 ? 0.5 : 0.25;
  let grid = '';
  for (let v = Math.ceil(yMin / stepY) * stepY; v <= yMax; v += stepY) {
    grid += `<line x1="${PAD_L}" y1="${y(v).toFixed(1)}" x2="${W - PAD_R}" y2="${y(v).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`
      + `<text x="${PAD_L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.label}">${v.toFixed(1)}</text>`;
  }

  let xlabels = '';
  const firstHour = Math.ceil(start / 3600000) * 3600000;
  for (let t = firstHour; t <= end; t += 6 * 3600000) {
    const d = new Date(t);
    xlabels += `<text x="${x(t).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="${C.label}">${d.getHours()}h</text>`;
  }

  const nowX = x(now.getTime()).toFixed(1);
  // Hauteur d'eau actuelle : échantillon le plus proche de « maintenant ».
  let nowH = null;
  let bestDiff = Infinity;
  for (const s of samples) {
    const d = Math.abs(s.t - now.getTime());
    if (d < bestDiff) { bestDiff = d; nowH = s.h; }
  }
  const nowLabel = nowH !== null && bestDiff < 30 * 60 * 1000
    ? `maintenant · ${nowH.toFixed(1)} m`
    : 'maintenant';
  const nowLine = `<line x1="${nowX}" y1="${PAD_T}" x2="${nowX}" y2="${H - PAD_B}" stroke="#d0782a" stroke-width="1.5" stroke-dasharray="4 3"/>`
    + `<text x="${nowX}" y="${PAD_T + 10}" text-anchor="middle" font-size="9" fill="#d0782a">${nowLabel}</text>`;

  const marks = usable
    .filter((e) => e.time.getTime() >= start && e.time.getTime() <= end)
    .map((e) => {
      const high = e.type === 'high';
      const cy = y(e.height);
      const ly = high ? cy - 8 : cy + 16;
      const idx = sorted.indexOf(e);
      const coef = tideCoefficient(sorted, idx);
      const label = `${high ? 'PM' : 'BM'} ${e.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${e.height.toFixed(1)} m`
        + (coef ? ` · c.${coef}` : '');
      const anchor = x(e.time.getTime()) > W - 90 ? 'end' : (x(e.time.getTime()) < PAD_L + 60 ? 'start' : 'middle');
      return `<circle cx="${x(e.time.getTime()).toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${high ? C.line : '#5a8ea6'}"/>`
        + `<text x="${x(e.time.getTime()).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" font-size="9" fill="${C.mark}">${label}</text>`
        + `<title>${e.time.toLocaleString('fr-FR')} — ${high ? 'marée haute' : 'marée basse'} ${e.height.toFixed(1)} m</title>`;
    }).join('');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Courbe de marée sur 24 heures">
    ${grid}${xlabels}
    <path d="${area}" fill="${C.area}" opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${C.line}" stroke-width="2.5" stroke-linejoin="round"/>
    ${nowLine}${marks}
  </svg>`;
}
