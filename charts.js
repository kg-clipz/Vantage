import { Donki, Eonet } from './spaceweather.js';
import { allLaunchesOf, statusBucket } from './missions.js';
import { allNeosOf } from './asteroids.js';
import { marsPhotosOf } from './rovers.js';
/* ================================================================
   Vantage — js/modules/charts.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */

import { $, Store, httpJSON, esc, fmt, num, isoDate } from '../api.js';
/* ================================================================
   Charts (Chart.js)
   ================================================================ */
const Charts = {
  _charts: {},
  theme(){
    const cs = getComputedStyle(document.documentElement);
    return {
      text: cs.getPropertyValue('--text-2').trim(),
      grid: cs.getPropertyValue('--chart-grid').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
      warm: cs.getPropertyValue('--warm').trim(),
      hot: cs.getPropertyValue('--hot').trim(),
      ok: cs.getPropertyValue('--ok').trim(),
      purple: cs.getPropertyValue('--purple').trim(),
      font: "'Space Grotesk', sans-serif",
    };
  },
  retheme(){
    // rebuild existing charts so colors follow the theme
    Charts.buildMissions(); Charts.buildNeos(); Charts.buildMars(); Charts.buildKp();
    Donki.buildChart(); Eonet.buildChart();
  },
  /* the SWPC chart is driven by a module the console boots late, so it rebuilds through here
     rather than being wired into every theme/view path individually */
  buildKp(){ if(typeof Swpc !== 'undefined' && Swpc.data && Object.keys(Swpc.data).length) Swpc.chart(); },
  make(canvasId, cfg){
    const canvas = $(canvasId);
    if(!canvas) return;
    // Data hygiene. Live feeds return gaps, and Chart.js renders bogus categories for
    // them — but labels and every dataset must be dropped *together*: filtering them
    // independently shifts the series against its categories.
    if(cfg && cfg.data){
      const blank = v => v === null || v === undefined || (typeof v === 'number' && !isFinite(v));
      const sets = Array.isArray(cfg.data.datasets) ? cfg.data.datasets : [];
      const labels = Array.isArray(cfg.data.labels) ? cfg.data.labels : null;
      const drop = new Set();
      sets.forEach(ds => { if(Array.isArray(ds.data)) ds.data.forEach((v, i) => { if(blank(v)) drop.add(i); }); });
      if(labels) labels.forEach((l, i) => { if(l === null || l === undefined || l === '') drop.add(i); });
      if(labels) cfg.data.labels = labels.filter((_, i) => !drop.has(i));
      if(sets.length) cfg.data.datasets = sets.map(ds => {
        const src = Array.isArray(ds.data) ? ds.data : [];
        const bg = Array.isArray(ds.backgroundColor) && ds.backgroundColor.length === src.length
          ? ds.backgroundColor.filter((_, i) => !drop.has(i))
          : ds.backgroundColor;
        return Object.assign({}, ds, { data: src.filter((_, i) => !drop.has(i)), backgroundColor: bg });
      });
    }
    // destroy any live instance first — Chart.js registers the canvas globally,
    // so re-instantiating without destroy() throws "Canvas is already in use"
    const existing = Chart.getChart(canvas);
    if(existing){
      existing.destroy();
    }
    delete Charts._charts[canvasId];
    const t = Charts.theme();
    Chart.defaults.font.family = t.font;
    Chart.defaults.color = t.text;
    Charts._charts[canvasId] = new Chart(canvas, Object.assign({
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { boxWidth: 10, boxHeight: 10 } } }
    }, cfg));
  },
  refresh(view){
    // rebuild only the charts of the view being entered — keeps sizes correct
    // after theme changes while the view was hidden
    if(view === 'weather') this.buildKp();
    if(view === 'missions') this.buildMissions();
    else if(view === 'asteroids') this.buildNeos();
    else if(view === 'mars') this.buildMars();
    else if(view === 'weather') Donki.buildChart();
    else if(view === 'events') Eonet.buildChart();
  },
  buildMissions(){
    if(!allLaunchesOf().length) return;
    const t = Charts.theme();
    // by provider
    const byAgency = {};
    allLaunchesOf().forEach(l => { byAgency[l.agency] = (byAgency[l.agency] || 0) + 1; });
    const aEntries = Object.entries(byAgency).sort((a, b) => b[1] - a[1]).slice(0, 8);
    Charts.make('chart-agency', {
      type: 'bar',
      data: { labels: aEntries.map(e => e[0]), datasets: [{ label: 'launches', data: aEntries.map(e => e[1]), backgroundColor: t.accent, borderRadius: 5 }] },
      options: { indexAxis: 'y', scales: { x: { grid: { color: t.grid }, ticks: { precision: 0 } }, y: { grid: { display: false } } }, plugins: { legend: { display: false } } }
    });
    // readiness mix
    const go = allLaunchesOf().filter(l => statusBucket(l.statusAbbrev) === 'go').length;
    const tbd = allLaunchesOf().filter(l => statusBucket(l.statusAbbrev) === 'tbd').length;
    const hold = allLaunchesOf().length - go - tbd;
    Charts.make('chart-status', {
      type: 'doughnut',
      data: { labels: ['Go / confirmed', 'TBD', 'Hold / other'], datasets: [{ data: [go, tbd, hold], backgroundColor: [t.ok, t.warm, t.hot], borderColor: 'transparent', borderWidth: 2 }] },
      options: { cutout: '62%', plugins: { legend: { position: 'bottom' } } }
    });
    // cadence by day
    const byDay = {};
    allLaunchesOf().forEach(l => { const k = isoDate(l.dateObj); byDay[k] = (byDay[k] || 0) + 1; });
    const days = Object.keys(byDay).sort();
    Charts.make('chart-cadence', {
      type: 'line',
      data: { labels: days, datasets: [{ label: 'launches', data: days.map(k => byDay[k]), borderColor: t.purple, backgroundColor: t.purple + '33', fill: true, tension: .35, pointRadius: 3 }] },
      options: { scales: { x: { grid: { color: t.grid } }, y: { grid: { color: t.grid }, ticks: { precision: 0 }, beginAtZero: true } }, plugins: { legend: { display: false } } }
    });
  },
  buildNeos(){
    if(!allNeosOf().length) return;
    const t = Charts.theme();
    // miss distance buckets (lunar distances)
    const buckets = [1, 3, 5, 10, 20, 80];
    const labels = ['<1 LD', '1–3', '3–5', '5–10', '10–20', '>20'];
    const counts = new Array(buckets.length).fill(0);
    allNeosOf().forEach(r => {
      if(!Number.isFinite(r.missLunar)) return;   // no distance — not bucketable
      let i = buckets.findIndex(b => r.missLunar < b);
      if(i === -1) i = buckets.length - 1;
      counts[i]++;
    });
    Charts.make('chart-neo-miss', {
      type: 'bar',
      data: { labels, datasets: [{ label: 'objects', data: counts, backgroundColor: t.accent, borderRadius: 5 }] },
      options: { scales: { x: { grid: { display: false } }, y: { grid: { color: t.grid }, ticks: { precision: 0 }, beginAtZero: true } }, plugins: { legend: { display: false } } }
    });
    // largest individual objects: NEO name → estimated maximum diameter (metres), top 10
    const bySize = [...allNeosOf()].sort((a, b) => (b.diamMax || b.diam) - (a.diamMax || a.diam)).slice(0, 10);
    Charts.make('chart-neo-size', {
      type: 'bar',
      data: {
        labels: bySize.map(r => r.name),
        datasets: [{
          label: 'est. max diameter (m)',
          data: bySize.map(r => Math.round((r.diamMax || r.diam) * 10) / 10),
          backgroundColor: bySize.map(r => r.hazardous ? t.hot : t.purple),
          borderRadius: 5
        }]
      },
      options: {
        indexAxis: 'y',
        scales: { x: { type: 'logarithmic', grid: { color: t.grid }, title: { display: true, text: 'metres (log scale)' } }, y: { grid: { display: false } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${fmt(ctx.parsed.x, 0)} m${bySize[ctx.dataIndex] && bySize[ctx.dataIndex].hazardous ? ' · hazardous' : ''}` } }
        }
      }
    });
  },
  buildMars(){
    if(!marsPhotosOf().length) return;
    const t = Charts.theme();
    const byCam = {};
    marsPhotosOf().forEach(p => { byCam[p.camera.name] = (byCam[p.camera.name] || 0) + 1; });
    const entries = Object.entries(byCam).sort((a, b) => b[1] - a[1]);
    Charts.make('chart-mars-cam', {
      type: 'bar',
      data: { labels: entries.map(e => e[0]), datasets: [{ label: 'photos', data: entries.map(e => e[1]), backgroundColor: t.purple, borderRadius: 5 }] },
      options: { indexAxis: 'y', scales: { x: { grid: { color: t.grid }, ticks: { precision: 0 } }, y: { grid: { display: false } } }, plugins: { legend: { display: false } } }
    });
  }
};

export { Charts };
