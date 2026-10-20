/* ================================================================
   Vantage — js/app.js
   Entry module: the monolith boot block, verbatim, plus the one
   NASA_KEY mutable binding the boot block mutates.
   ================================================================ */
import { $, Store, setNasaKey, getNasaKey, isoDate, todayIso, Seq, SampleData, pad, RateLimit, Skeleton } from './api.js';
import { toast, applyTheme, savedTheme, showView, Range, openModal, closeModal } from './ui.js';
import { initMapOnce, IssFeed, IssTrack, refreshMapSoon, ensureEventsMap, refreshEventsMapSoon, refreshEventsMapSize, getEventsMap, lastIssOf } from './modules/iss.js';
import { loadApod, loadEpic } from './modules/apod.js';
import { loadLaunches, allLaunchesOf, statusClass } from './modules/missions.js';
import { loadNeo, allNeosOf } from './modules/asteroids.js';
import { loadMarsLatest } from './modules/rovers.js';
import { Charts } from './modules/charts.js';
import { buildBrief } from './modules/brief.js';
import { Donki, Eonet, Swpc } from './modules/spaceweather.js';
import { Aurora } from './modules/aurora.js';
import { SolarDisk } from './modules/solar.js';
import { MissionModal } from './modules/mission.js';
import { Storms } from './modules/storms.js';
import { Chime, Ambient, Comms } from './audio.js';
import { PassPredict } from './modules/passpredict.js';
import { Timeline } from './modules/timeline.js';
import { Jellyfish } from './modules/jellyfish.js';
import { GeoTools } from './modules/geotools.js';

let NASA_KEY = getNasaKey();
/* ---------------- boot ---------------- */
applyTheme(savedTheme);
// Launch Library is a separate API (no shared quota) — start it immediately;
// the five NASA calls go through the staggered queue so the demo key isn't burned in a burst
loadLaunches();
setTimeout(loadNeo, 100);
setTimeout(loadApod.bind(null, todayIso), 1000);
setTimeout(loadEpic.bind(null, null), 1900);
setTimeout(loadMarsLatest, 2800);
// the station feed's own controls: the frame itself only mounts when asked for
IssFeed.init();
// EONET lives on its own key-less host, so it can run alongside the NASA queue…
setTimeout(() => Eonet.load(), 3400);
// …while DONKI spends api.nasa.gov quota, so it goes last in the stagger
setTimeout(() => Donki.load(), 4400);
// alert preferences and the (key-less, cached) pass list come up without waiting on NASA
Chime.init();
/* Comms binds its own toggle button, so it has to initialise at boot rather than on first use
   — the button *is* the first use, and a handler that only installs itself when clicked
   installs itself too late. */
Comms.init();
/* the jellyfish panel drives the pass predictor's observer rather than keeping its own copy —
   its search box, coordinates and pad presets all write through to the one shared viewpoint —
   and its wiring is installed here, at boot, rather than by the first click that needs it */
Jellyfish.init();
const ppRender = PassPredict.render.bind(PassPredict);
PassPredict.render = function(){ ppRender(); try{ Jellyfish.render(); }catch(e){} };
PassPredict.init();
setTimeout(() => Aurora.arm(), 6000);   // deferred: the OVATION grid is ~900 KB
// NOAA SWPC is key-less and every product is small, so the real-time panel comes up early —
// it feeds the Kp forecast list and the timeline strip as well as its own tiles
setTimeout(() => Swpc.load(), 1200);
// the jellyfish watch reads the manifest, and paints its empty state before one exists
Jellyfish.render();
// NHC's active-storm list and the ArcGIS forecast-cone layers live on NOAA hosts of their own
setTimeout(() => Storms.load(), 3200);
// the timeline reads only state the modules above already hold, so it starts with no calls
Timeline.start();

/* Every section registers its placeholder here. Five seconds of an untouched skeleton means
   "this is not loading, this failed quietly", so it becomes a retry prompt the viewer can
   actually use — no permanent spinner anywhere in the console. A loader that lands its data
   (or its own sample/error state) inside the window is untouched. */
Skeleton.watch('launch-list', 'launch-list', loadLaunches, 'The launch manifest is taking longer than expected.');
Skeleton.watch('next-launch', 'next-launch-card', loadLaunches, 'The launch manifest is taking longer than expected.');
Skeleton.watch('neo-body', 'neo-body', loadNeo, 'The asteroid feed is taking longer than expected.',
  html => '<tr><td colspan="6">' + html + '</td></tr>');
Skeleton.watch('top-neo', 'top-neo-card', loadNeo, 'The asteroid feed is taking longer than expected.');
Skeleton.watch('apod-media', 'apod-media', () => loadApod(todayIso), 'The picture of the day is taking longer than expected.');
Skeleton.watch('epic-strip', 'epic-strip', () => loadEpic(null), 'The EPIC archive is taking longer than expected.');
Skeleton.watch('mars-latest', 'mars-latest', loadMarsLatest, 'Rover status is slow to answer — this feed can take half a minute.');
Skeleton.watch('donki-list', 'donki-list', () => Donki.load(), 'Space-weather data is taking longer than expected.');
Skeleton.watch('eonet-list', 'eonet-list', () => Eonet.load(), 'Natural-event data is taking longer than expected.');
Skeleton.watch('kp-forecast', 'kp-forecast', () => Swpc.load(true), 'The NOAA Kp forecast is taking longer than expected.');

/* ---------------- tropical-system controls ---------------- */
if($('storm-paths')) $('storm-paths').addEventListener('click', () => Storms.setPaths(!Storms.paths));
Storms.setPaths(true);


/* ---------------- NASA key setting ---------------- */
function refreshKeyBtn(){
  $('keyBtn').textContent = 'NASA key: ' + (NASA_KEY === 'DEMO_KEY' ? 'demo' : NASA_KEY.slice(0, 4) + '…');
}
function applyNasaKey(k){
  NASA_KEY = k.trim() || 'DEMO_KEY';
  Store.set('vantage-nasa-key', NASA_KEY);
  refreshKeyBtn();
  RateLimit.hide(); // new key in play — give live feeds the benefit of the doubt
  toast(NASA_KEY === 'DEMO_KEY' ? 'Reverted to the shared demo key' : 'Key saved — reloading NASA feeds');
  loadApod(todayIso);
  loadEpic(null);
  loadNeo();
  loadMarsLatest();
}
$('keyBtn').addEventListener('click', () => {
  $('keyInput').value = NASA_KEY === 'DEMO_KEY' ? '' : NASA_KEY;
  $('keyModalBackdrop').classList.add('open');
  setTimeout(() => $('keyInput').focus(), 50);
});
$('keyCancel').addEventListener('click', () => $('keyModalBackdrop').classList.remove('open'));
$('keyModalBackdrop').addEventListener('click', e => { if(e.target === $('keyModalBackdrop')) $('keyModalBackdrop').classList.remove('open'); });
$('keyUseDemo').addEventListener('click', () => { $('keyModalBackdrop').classList.remove('open'); applyNasaKey(''); });
$('keySave').addEventListener('click', () => {
  const v = $('keyInput').value.trim();
  $('keyModalBackdrop').classList.remove('open');
  applyNasaKey(v);
});
$('keyInput').addEventListener('keydown', e => { if(e.key === 'Enter') $('keySave').click(); });
refreshKeyBtn();

/* ---------------- rate-limit banner wiring ---------------- */
$('rl-key-btn').addEventListener('click', () => $('keyBtn').click());
$('rl-close').addEventListener('click', () => RateLimit.hide());

/* ---------------- online / offline status ---------------- */
function updateNetBanner(forceOffline){
  const offline = typeof forceOffline === 'boolean' ? forceOffline : !navigator.onLine;
  $('net-banner').classList.toggle('show', offline);
}
window.addEventListener('offline', () => updateNetBanner(true));
window.addEventListener('online', () => {
  updateNetBanner(false);
  toast('Back online — refreshing all feeds');
  loadLaunches(true); loadNeo(); loadApod(todayIso); loadEpic(null); loadMarsLatest(); Donki.load(); Eonet.load();
});
updateNetBanner();

/* ---------------- error boundary ----------------
   A dropped connection, a rejected promise with no catch, or an exception inside a timer must
   never be able to wedge the console or flood the log silently. Everything funnels through
   one place that records it, warns once, and — only when it is news — tells the viewer what
   happened and which card to retry. Deliberately quiet while offline: the network banner
   already says it, so toasting every stalled request on top of it would be noise. */
const Errors = {
  count: 0, lastAt: 0, lastMsg: '',
  report(kind, reason){
    this.count++;
    const msg = String((reason && (reason.message || reason)) || 'unknown error');
    if(window.console && console.warn) console.warn('[vantage] ' + kind + ':', reason);
    if(typeof navigator !== 'undefined' && !navigator.onLine) return;
    const now = Date.now();
    if(msg !== this.lastMsg || now - this.lastAt > 20000){
      this.lastAt = now; this.lastMsg = msg;
      toast('A background request failed (' + msg.slice(0, 52) + ') — press ↻ retry on the affected card');
    }
  }
};
/* an unhandled rejection is the classic silent failure: the promise dies, the placeholder
   stays, and nothing tells the viewer. Report it, then suppress the default console error
   rather than letting it look like a crash. */
window.addEventListener('unhandledrejection', e => {
  const r = (e && e.reason) || {};
  Errors.report(r.network ? 'network rejection' : 'unhandled rejection', r);
  if(e && e.preventDefault) e.preventDefault();
});
window.addEventListener('error', e => {
  if(!e || !e.message) return;
  Errors.report('runtime error', { message: e.message });
});

/* ---------------- offline caching (service worker) ----------------
   A service worker can only be registered from a real http(s) origin: file:// has no scope
   to register into, and a blob: script is not permitted to register one. So it is registered
   where it can be and the console carries on unchanged where it cannot — the app-shell cache
   is a convenience, never a dependency. The worker itself is the sibling file `sw.js`.

   What it caches is deliberately narrow: static assets — this page, the fonts, the Leaflet
   and Chart.js CDNs — are served from cache when the network is gone, while every live API
   call is left to the network and its own sample-data fallback, because a cached asteroid
   list is not a substitute for a current one. */
const OfflineCache = {
  supported(){ return ('serviceWorker' in navigator) && /^https?:$/.test(location.protocol); },
  async register(){
    const el = $('sw-status');
    if(!this.supported()){
      if(el) el.textContent = /^https?:$/.test(location.protocol) ? 'not supported in this browser' : 'unavailable over file:// — serve the page over http(s) to enable';
      return;
    }
    try{
      const reg = await navigator.serviceWorker.register('sw.js');
      if(el) el.textContent = 'active — app shell reopens offline';
      /* the worker announces how much it has banked, which is the only honest way to know
         the cache is actually warm rather than merely registered */
      navigator.serviceWorker.addEventListener('message', ev => {
        if(ev.data && ev.data.type === 'cached' && el){
          el.textContent = 'active — ' + ev.data.count + ' assets cached';
        }
      });
      if(reg && reg.active && el) el.textContent = 'active — app shell reopens offline';
    }catch(e){
      /* A missing or unreachable sw.js is an expected condition — the page may be served
         from a single file, or the worker simply not deployed yet. It is not a background
         request the viewer needs to be told about, so it is logged and shown in the status
         line rather than raised through the error boundary. */
      if(el) el.textContent = 'not available here — the page still works, it just cannot reopen offline';
      if(window.console && console.info) console.info('[vantage] offline cache not registered:', e && e.message);
    }
  }
};
OfflineCache.register();

/* ---------------- data export (CSV / JSON) ---------------- */
function downloadFile(name, content, type){
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function toCsv(rows){
  if(!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
}
$('export-launches-csv').addEventListener('click', () => {
  const rows = allLaunches.map(l => ({
    date: l.dateObj.toISOString(), name: l.name, provider: l.agency, vehicle: l.rocket,
    status: l.statusName, pad: l.pad
  }));
  downloadFile('vantage-launches.csv', toCsv(rows), 'text/csv');
  toast(`Exported ${rows.length} launches`);
});
$('export-launches-json').addEventListener('click', () => {
  downloadFile('vantage-launches.json', JSON.stringify(allLaunches, null, 2), 'application/json');
  toast(`Exported ${allLaunches.length} launches`);
});
$('export-neo-csv').addEventListener('click', () => {
  const rows = allNeos.map(r => ({
    designation: r.name, close_approach: r.date,
    miss_lunar_dist: r.missLunar === null ? '' : r.missLunar,
    miss_km: Number.isFinite(r.missKm) ? Math.round(r.missKm) : '',
    velocity_kms: r.vel === null ? '' : r.vel,
    est_diam_m: Number.isFinite(r.diam) ? Math.round(r.diam) : '',
    est_diam_max_m: Number.isFinite(r.diamMax) ? Math.round(r.diamMax) : '',
    abs_magnitude_h: r.mag === null ? '' : r.mag,
    hazardous: r.hazardous ? 'yes' : 'no'
  }));
  downloadFile('vantage-asteroids.csv', toCsv(rows), 'text/csv');
  toast(`Exported ${rows.length} objects`);
});
$('export-neo-json').addEventListener('click', () => {
  downloadFile('vantage-asteroids.json', JSON.stringify(allNeos, null, 2), 'application/json');
  toast(`Exported ${allNeos.length} objects`);
});
$('export-donki-csv').addEventListener('click', () => {
  const rows = Donki.events.map(e => ({
    type: e.kind, id: e.id, time: e.time, summary: e.title, detail: e.detail,
    xray_class: e.cls || '', kp_index: e.kp != null ? e.kp : '', speed_kms: e.speed || ''
  }));
  if(!rows.length){ toast('Nothing to export yet'); return; }
  downloadFile('vantage-space-weather.csv', toCsv(rows), 'text/csv');
  toast(`Exported ${rows.length} space weather events`);
});
$('export-donki-json').addEventListener('click', () => {
  downloadFile('vantage-space-weather.json', JSON.stringify(Donki.events, null, 2), 'application/json');
  toast(`Exported ${Donki.events.length} space weather events`);
});
$('export-eonet-csv').addEventListener('click', () => {
  const rows = Eonet.events.map(ev => {
    const g = Eonet.latest(ev), ll = Eonet.coords(g);
    return {
      title: ev.title, category: Eonet.cat(Eonet.catId(ev)).l,
      date: g && g.date ? g.date : '', latitude: ll ? ll[0].toFixed(3) : '', longitude: ll ? ll[1].toFixed(3) : '',
      region: ll ? GeoTools.short(ll[0], ll[1]) : '',
      magnitude: g && g.magnitudeValue != null ? g.magnitudeValue : '', unit: (g && g.magnitudeUnit) || '',
      source: (ev.sources && ev.sources[0] && ev.sources[0].url) || ''
    };
  });
  if(!rows.length){ toast('Nothing to export yet'); return; }
  downloadFile('vantage-natural-events.csv', toCsv(rows), 'text/csv');
  toast(`Exported ${rows.length} natural events`);
});
$('export-eonet-json').addEventListener('click', () => {
  downloadFile('vantage-natural-events.json', JSON.stringify(Eonet.events, null, 2), 'application/json');
  toast(`Exported ${Eonet.events.length} natural events`);
});

/* ---------------- space weather + natural event controls ---------------- */
$('donki-filter').addEventListener('change', () => Donki.renderList());
$('donki-reload').addEventListener('click', () => Donki.load());
$('eonet-map-btn').addEventListener('click', () => Eonet.fitAll());
$('eonet-all-cats').addEventListener('click', () => { Eonet.selectAll(); toast('All categories shown'); });
$('eonet-days').addEventListener('change', e => {
  Eonet.DAYS = Number(e.target.value);
  refreshEventsMapSoon();
  toast(`Pulling the past ${Eonet.DAYS} days of natural events`);
  Eonet.load(Eonet.DAYS);
});
$('aurora-toggle').addEventListener('click', () => Aurora.toggle());

/* ---------------- ISS pass predictor + alerts ---------------- */
$('pass-go').addEventListener('click', () => PassPredict.run(true));
$('pass-geo').addEventListener('click', () => PassPredict.geo());
$('pass-visible').addEventListener('click', () => PassPredict.toggleVisible());
if($('pass-help')) $('pass-help').addEventListener('click', e => { e.stopPropagation(); PassPredict.toggleHelp(); });
if($('pass-help-pop')) $('pass-help-pop').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => PassPredict.closeHelp());
document.addEventListener('keydown', e => { if(e.key === 'Escape' && PassPredict.closeHelp()) e.stopPropagation(); }, true);
['pass-lat', 'pass-lon'].forEach(id => {
  $(id).addEventListener('change', () => PassPredict.run(false));
  $(id).addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); PassPredict.run(true); } });
});
$('alertToggle').addEventListener('click', () => Chime.toggle());

/* ---------------- ambient audio controls ---------------- */
$('audioToggle').addEventListener('click', e => {
  e.stopPropagation();
  const panel = $('audioPanel');
  const open = panel.classList.toggle('open');
  if(open && !Ambient.playing) Ambient.start();   // the click itself satisfies autoplay policy
});
document.addEventListener('click', e => {
  const wrap = document.querySelector('.audio-wrap');
  if(wrap && !wrap.contains(e.target)) $('audioPanel').classList.remove('open');
});
$('audioVol').addEventListener('input', e => Ambient.setVolume(e.target.value));
$('audioStop').addEventListener('click', e => { e.stopPropagation(); Ambient.toggle(); });
$('sun-reset').addEventListener('click', () => SolarDisk.reset());
$('iss-follow').addEventListener('click', () => IssTrack.toggle());
IssTrack.paint();
$('audioVol').value = String(Ambient.vol);
$('audioPct').textContent = Ambient.vol + '%';
Ambient.armResume();

/* ---------------- solar locator ---------------- */
if($('sun-stage')) SolarDisk.render();

/* ---------------- keyboard shortcuts ----------------
   1–8 switch views · / focuses launch search · m ambient audio · a audio alerts · , mission audio
   t and j open the two extra pages — the 24-hour timeline and the jellyfish outlook — which are
   views like any other, listed in the nav with a badge that states something before they are
   opened. Esc is handled by the modal listeners. */
const VIEW_ORDER = ['overview', 'sky', 'missions', 'asteroids', 'mars', 'weather', 'events', 'brief'];
document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea' || tag === 'select' || e.metaKey || e.ctrlKey || e.altKey) return;
  if(e.key >= '1' && e.key <= '8'){
    const v = VIEW_ORDER[Number(e.key) - 1];
    if(v){ showView(v); }
  } else if(e.key === '/'){
    e.preventDefault();
    showView('missions');
    const s = $('launch-search');
    s.focus(); s.select();
  } else if(e.key === 'm' || e.key === 'M'){
    Ambient.toggle();
  } else if(e.key === 'a' || e.key === 'A'){
    Chime.toggle();
  } else if(e.key === ','){
    Comms.panel();
  } else if(e.key === 't' || e.key === 'T'){
    showView('timeline');
  } else if(e.key === 'j' || e.key === 'J'){
    showView('jellyfish');
  }
});
/* the Missions card is a way in to the panel, so the click is delegated — the button is
   markup, and markup should not need a bespoke listener of its own */
document.addEventListener('click', e => {
  const b = e.target && e.target.closest ? e.target.closest('[data-jf-open]') : null;
  if(b) showView('jellyfish');
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    $('audioPanel').classList.remove('open');
    $('commsPanel').classList.remove('open');
    $('commsToggle').setAttribute('aria-pressed', 'false');
  }
});

