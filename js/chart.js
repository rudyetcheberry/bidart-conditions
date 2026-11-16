import { matchesCriteria } from './alerts.js';

const W = 660;
const H = 240;
const PAD_L = 42;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 30;

export function renderSwellChart(container, marine, config) {
  if (!container) return;
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

  const line = pts
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.time.getTime()).toFixed(1)},${y(p.swellHeight).toFixed(1)}`)
    .join(' ');
  const baseY = (H - PAD_B).toFixed(1);
  const area = `${line} L${x(t1).toFixed(1)},${baseY} L${x(t0).toFixed(1)},${baseY} Z`;

  const step = maxV > 6 ? 2 : maxV > 3 ? 1 : 0.5;
  let grid = '';
  for (let v = 0; v <= maxV; v += step) {
    grid += `<line x1="${PAD_L}" y1="${y(v).toFixed(1)}" x2="${W - PAD_R}" y2="${y(v).toFixed(1)}" stroke="#e6edf1" stroke-width="1"/>`
      + `<text x="${PAD_L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#6b7c86">${v.toFixed(1)}</text>`;
  }

  let xlabels = '';
  pts.forEach((p) => {
    const hourIndex = Math.round((p.time.getTime() - t0) / 3600000);
    if (hourIndex % 6 === 0) {
      const day = p.time.toLocaleDateString('fr-FR', { weekday: 'short' });
      const hour = p.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      xlabels += `<text x="${x(p.time.getTime()).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#6b7c86">${day} ${hour}</text>`;
    }
  });

  const bandTop = y(Math.min(config.swellMax, maxV)).toFixed(1);
  const bandBottom = y(config.swellMin).toFixed(1);
  const band = `<rect x="${PAD_L}" y="${bandTop}" width="${W - PAD_L - PAD_R}" height="${(bandBottom - bandTop).toFixed(1)}" fill="#1d8a4e" opacity="0.12"/>`;

  const dots = pts.map((p) => {
    const { ok } = matchesCriteria(p, config);
    const period = typeof p.swellPeriod === 'number' ? `${p.swellPeriod} s` : '—';
    return `<circle cx="${x(p.time.getTime()).toFixed(1)}" cy="${y(p.swellHeight).toFixed(1)}" r="3" fill="${ok ? '#1d8a4e' : '#b03a3a'}">`
      + `<title>${p.time.toLocaleString('fr-FR')} — ${p.swellHeight.toFixed(1)} m · ${period}</title></circle>`;
  }).join('');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Courbe de houle sur 48 heures">
    ${band}${grid}${xlabels}
    <path d="${area}" fill="#0e7fb0" opacity="0.15"/>
    <path d="${line}" fill="none" stroke="#0e7fb0" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}
