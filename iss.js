import { toast } from '../ui.js';
import { GeoTools } from './geotools.js';
/* ================================================================
   Vantage — js/modules/iss.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */

import { $, Store, httpJSON, esc, fmt, num, isoDate } from '../api.js';
/* ================================================================
   ISS live tracker
   ================================================================ */
/* two independent Leaflet instances: the station tracker (Overview) and the natural-events
   map (Space Weather). Keeping them separate means hazard markers never clutter ISS
   telemetry, and each map can be sized for its own view. */
let map, eventsMap, marker, issTrail = [], lastIss = null, issHistory = [];
/* English-only labelling, with no API key. CARTO's raster endpoints were the first choice
   here, but they now stamp "API KEY REQUIRED" diagonally across every tile unless you
   register a key, and OSM's own tiles print local names ("Deutschland", "日本") that read as
   a glitch at depth. Esri's canvas sets are key-less, label in English worldwide, and ship a
   *purpose-built dark variant* — so the console swaps tile sets with the theme instead of
   inverting a light basemap with a CSS filter. */
const Basemaps = {
  dark: {
    base:   'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    credit: 'Basemap &copy; Esri · Dark Gray Canvas · English place names'
  },
  light: {
    base:   'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    credit: 'Basemap &copy; Esri · Light Gray Canvas · English place names'
  }
};
function paintBasemap(m, slotName, onResize){
  if(!m || typeof L === 'undefined') return null;
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const set = Basemaps[theme];
  const old = window[slotName];
  if(old){ try{ m.removeLayer(old.tiles); m.removeLayer(old.labels); }catch(e){} }
  const tiles = L.tileLayer(set.base, { maxZoom: 17, maxNativeZoom: 16, attribution: set.credit }).addTo(m);
  // the base layer's credit already names Esri and the English labelling; a second copy here
  // wrapped the attribution onto two lines and covered the map legend
  const labels = L.tileLayer(set.labels, { maxZoom: 17, maxNativeZoom: 16, attribution: '' }).addTo(m);
  window[slotName] = { tiles, labels };
  // a dropped tile request leaves a permanent gray square — nudge a redraw a few times
  let retries = 0;
  const retry = () => {
    if(retries >= 3) return;
    retries++;
    setTimeout(() => { if(onResize) onResize(); tiles.redraw(); labels.redraw(); }, 1200 * retries);
  };
  tiles.on('tileerror', retry);
  labels.on('tileerror', retry);
  return window[slotName];
}
/* both maps carry the same key-less English-label canvas set, swapped with the theme */
function applyBasemap(){
  paintBasemap(map, '__mapTiles', refreshMapSize);
  paintBasemap(eventsMap, '__eventsTiles', refreshEventsMapSize);
}
function initMap(){
  map = L.map('map', { zoomControl: true, attributionControl: true, worldCopyJump: true, maxZoom: 17 }).setView([0, 0], 2);
  applyBasemap();
  const issIcon = L.divIcon({
    className: '',
    html: '<div style="width:14px;height:14px;border-radius:50%;background:#4F8CFF;box-shadow:0 0 0 5px rgba(79,140,255,.22),0 0 16px #4F8CFF;"></div>',
    iconSize: [14, 14], iconAnchor: [7, 7]
  });
  marker = L.marker([0, 0], { icon: issIcon }).addTo(map);
}
initMap();

/* the natural-events map lives in the Space Weather view — hazards get their own canvas,
   the station tracker stays clean. It is created LAZILY, on the first frame where the view is
   actually visible: Leaflet measures the container when the map is built, and a display:none
   view measures 0×0, which silently positions every marker path off-screen. */
function ensureEventsMap(){
  const el = $('events-map');
  if(eventsMap){ refreshEventsMapSize(); return eventsMap; }
  if(typeof L === 'undefined' || !el || !el.clientWidth || !el.clientHeight) return null;
  eventsMap = L.map('events-map', { zoomControl: true, attributionControl: true, worldCopyJump: true, maxZoom: 17 }).setView([15, 10], 2);
  paintBasemap(eventsMap, '__eventsTiles', refreshEventsMapSize);
  // markers may have been computed while the view was hidden — rebuild them on the real canvas
  if(typeof Eonet !== 'undefined' && Eonet.attach) Eonet.attach();
  frameEvents();
  return eventsMap;
}
/* EONET's open set is heavily clustered — in September 2026 it is overwhelmingly the
   Americas — so a guessed centre can easily frame none of it and paint an empty ocean.
   Fit the actual events on first paint, with a zoom floor so the world still fills the box. */
function frameEvents(){
  if(!eventsMap || typeof Eonet === 'undefined' || !Eonet.byId) return;
  const pts = Object.keys(Eonet.byId).map(id => Eonet.byId[id].getLatLng());
  if(!pts.length) return;
  const b = L.latLngBounds(pts);
  eventsMap.fitBounds(b.pad(0.12), { maxZoom: 3, animate: false });
  if(eventsMap.getZoom() < 1) eventsMap.setView(b.getCenter(), 1, { animate: false });
}

/* re-measure a map whenever its container changes size or becomes visible — fixes gray/blank
   tiles when a view mounts hidden or the viewport shifts */
function sizeUp(m, elId){
  const el = $(elId);
  if(!m || !el || !el.clientWidth || !el.clientHeight) return;
  m.invalidateSize({ pan: false, animate: false });
}
function refreshMapSize(){ sizeUp(map, 'map'); }
function refreshEventsMapSize(){ sizeUp(eventsMap, 'events-map'); }
/* views are hidden/shown with a class toggle, so Leaflet keeps a stale tile grid and paints
   gray squares. Re-measure across a couple of frames and again once layout settles. */
function refreshMapSoon(){
  const both = () => { refreshMapSize(); refreshEventsMapSize(); };
  requestAnimationFrame(() => { both(); requestAnimationFrame(both); });
  clearTimeout(refreshMapSoon._t);
  refreshMapSoon._t = setTimeout(both, 260);
}
function refreshEventsMapSoon(){
  if(!eventsMap) return;
  requestAnimationFrame(() => { refreshEventsMapSize(); requestAnimationFrame(refreshEventsMapSize); });
  clearTimeout(refreshEventsMapSoon._t);
  refreshEventsMapSoon._t = setTimeout(refreshEventsMapSize, 260);
}
if(typeof ResizeObserver !== 'undefined'){
  [['map', refreshMapSize], ['events-map', refreshEventsMapSize]].forEach(pair => {
    const el = $(pair[0]);
    if(!el) return;
    let lw = 0, lh = 0;
    new ResizeObserver(entries => {
      const box = entries[0].contentRect;
      if(box.width === lw && box.height === lh && box.width > 0) return;
      lw = box.width; lh = box.height;
      pair[1]();
    }).observe(el);
  });
}
if(typeof IntersectionObserver !== 'undefined'){
  [['map', refreshMapSoon], ['events-map', refreshEventsMapSoon]].forEach(pair => {
    const el = $(pair[0]);
    if(!el) return;
    new IntersectionObserver(es => es.forEach(en => { if(en.isIntersecting) pair[1](); }), { threshold: 0.05 }).observe(el);
  });
}
window.addEventListener('resize', refreshMapSoon);
document.addEventListener('visibilitychange', () => { if(!document.hidden) refreshMapSoon(); });

/* ---------- the station feed: one embedded live stream ----------
   Exactly one video is embedded in this console, and it is mounted only when the viewer
   asks for it: a live broadcast nobody requested is bandwidth spent on someone who came
   for the telemetry. The frame is built by hand so it carries its own referrer policy,
   and a load watchdog says plainly what happened if the embed is refused rather than
   leaving a black rectangle sitting there. */
const IssFeed = {
  VIDEO: 'M3HKLzjvKPc',
  HOST: 'https://www.youtube-nocookie.com',
  ALLOW: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
  WAIT: 6000,
  frame: null, timer: null,
  embedUrl(){
    const q = ['autoplay=1', 'mute=1', 'playsinline=1', 'rel=0', 'modestbranding=1'];
    /* the origin parameter only means something over http(s): on file:// the page origin is
       the literal "null" and YouTube rejects the handshake, so it is left off rather than
       sent wrong — the frame still plays, it just has no origin to declare */
    if(/^https?:$/.test(location.protocol)) q.push('origin=' + encodeURIComponent(location.origin));
    return this.HOST + '/embed/' + this.VIDEO + '?' + q.join('&');
  },
  chip(text, cls){
    const c = $('iss-feed-chip');
    if(!c) return;
    c.textContent = text;
    c.className = 'live-chip' + (cls ? ' ' + cls : '');
  },
  init(){
    /* the play button is rebuilt by stop(), so it is bound whenever it is found unbound
       rather than once for the life of the page */
    const play = $('iss-feed-play');
    if(play && !play.dataset.bound){ play.dataset.bound = '1'; play.addEventListener('click', () => this.start()); }
    const stop = $('iss-feed-stop');
    if(stop && !stop.dataset.bound){ stop.dataset.bound = '1'; stop.addEventListener('click', () => this.stop()); }
  },
  start(){
    const stage = $('iss-feed-stage');
    if(!stage || this.frame) return;
    this.init();
    stage.querySelectorAll('.live-play, .live-hint').forEach(n => n.remove());
    const f = document.createElement('iframe');
    f.setAttribute('title', 'Live video from the International Space Station');
    f.setAttribute('allow', this.ALLOW);
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    let arrived = false;
    f.addEventListener('load', () => { arrived = true; clearTimeout(this.timer); });
    f.addEventListener('error', () => { clearTimeout(this.timer); this.fail(); });
    f.src = this.embedUrl();
    stage.appendChild(f);
    this.frame = f;
    this.chip('connecting…', 'off');
    this.timer = setTimeout(() => { if(!arrived) this.fail(); }, this.WAIT);
    /* `load` proves the player arrived, not that a broadcast is running — so the chip says
       what was actually observed rather than claiming a live picture */
    setTimeout(() => {
      if(!arrived || !stage.querySelector('iframe')) return;
      this.chip('video loaded', '');
      const m = $('iss-feed-meta');
      if(m) m.textContent = 'NASA\u2019s official ISS stream · unmute in the player';
    }, this.WAIT + 900);
  },
  fail(){
    this.chip('embed refused', 'warn');
    const stage = $('iss-feed-stage');
    if(stage && !stage.querySelector('.live-note')){
      stage.insertAdjacentHTML('beforeend',
        '<div class="live-hint live-note" role="note">the frame did not load here — the station feed always plays on YouTube itself, from the button above</div>');
    }
  },
  stop(){
    const stage = $('iss-feed-stage');
    clearTimeout(this.timer);
    /* blank the src before dropping the node: a detached frame can keep its audio going */
    if(this.frame){ try{ this.frame.src = 'about:blank'; }catch(e){} try{ this.frame.remove(); }catch(e){} }
    this.frame = null;
    if(stage) stage.innerHTML = '<button class="live-play" id="iss-feed-play" aria-label="Start the live video from the International Space Station">▶</button>'
      + '<span class="live-hint">live video from the orbiting station — plays here, loaded when you press play</span>';
    this.init();
    this.chip('not loaded', 'off');
  }
};

/* ---------- ISS map tracking: keep the canvas centred on the station ---------- */
const IssTrack = {
  KEY: 'vantage-iss-follow',
  on: Store.get('vantage-iss-follow', '0') === '1',
  apply(){
    if(!this.on || !lastIss || !map) return;
    const ll = [lastIss.latitude, lastIss.longitude];
    const dLon = Math.abs(ll[1] - map.getCenter().lng);
    // crossing the antimeridian would otherwise sweep the map the long way round the globe
    if(dLon > 180){ map.setView(ll, map.getZoom(), { animate: false }); return; }
    map.panTo(ll, { animate: true, duration: 1.2 });
  },
  centerNow(){
    if(!lastIss || !map) return;
    map.setView([lastIss.latitude, lastIss.longitude], Math.max(map.getZoom(), 3), { animate: true });
  },
  paint(){
    const btn = $('iss-follow');
    if(btn){
      btn.classList.toggle('on', this.on);
      btn.setAttribute('aria-pressed', this.on ? 'true' : 'false');
      btn.textContent = this.on ? '◉ following' : '⊙ follow ISS';
    }
    const badge = $('iss-follow-badge');
    if(badge) badge.classList.toggle('show', this.on);
  },
  toggle(){
    this.on = !this.on;
    Store.set(this.KEY, this.on ? '1' : '0');
    this.paint();
    if(this.on){
      this.centerNow();
      toast('Following the station — the map recentres on every fix');
    } else {
      toast('Follow off — the map stays where you leave it');
    }
  }
};

let issFailures = 0;
const ISS_STALE_MS = 30000;
function fetchWithTimeout(url, ms){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
function markIssStale(){
  if(!lastIss) return;
  const mins = Math.max(1, Math.round((Date.now() - (lastIss._receivedAt || Date.now())) / 60000));
  $('iss-updated').innerHTML = `last updated ${mins} min ago · <span style="color:var(--warm)">reconnecting…</span>`;
}
async function pollIss(){
  try{
    const res = await fetchWithTimeout('https://api.wheretheiss.at/v1/satellites/25544', 6500);
    if(!res.ok) throw new Error('iss fetch failed');
    const d = await res.json();
    issFailures = 0;
    d._receivedAt = Date.now();
    lastIss = d;
    issHistory.push({ t: d.timestamp, alt: d.altitude, vel: d.velocity });
    if(issHistory.length > 30) issHistory.shift();

    $('iss-lat').textContent = d.latitude.toFixed(2) + '°';
    $('iss-lon').textContent = d.longitude.toFixed(2) + '°';
    $('iss-alt').innerHTML = Math.round(d.altitude) + '<span class="unit">km</span>';
    $('iss-vel').innerHTML = Math.round(d.velocity).toLocaleString() + '<span class="unit">km/h</span>';

    // orbital period from vis-viva: a = R_e + h, mu = 398600.4418 km^3/s^2
    const Re = 6371, mu = 398600.4418;
    const a = Re + d.altitude;
    const periodMin = 2 * Math.PI * Math.sqrt(Math.pow(a, 3) / mu) / 60;
    $('iss-period').innerHTML = periodMin.toFixed(1) + '<span class="unit">min</span>';
    $('iss-orbits').textContent = (1440 / periodMin).toFixed(1);

    $('iss-status').textContent = d.visibility === 'daylight'
      ? 'In sunlight — orbiting at a ' + periodMin.toFixed(0) + '-minute period, tracing ~16 orbits a day.'
      : 'In orbital night — the station is in Earth\'s shadow for roughly half of every orbit.';
    // ground track → plain-language location, so the numbers mean something geographic
    $('iss-where').innerHTML = 'Ground track: <b>' + esc(GeoTools.line(d.latitude, d.longitude)) + '</b>';
    $('tile-iss-alt').innerHTML = Math.round(d.altitude) + ' <span style="font-size:12px;color:var(--text-3)">km</span>';
    $('tile-iss-sub').textContent = `${d.latitude.toFixed(1)}°, ${d.longitude.toFixed(1)}° · ${d.visibility === 'daylight' ? 'daylight' : 'night'}`;

    const now = new Date();
    $('iss-updated').textContent = 'last updated ' + now.toLocaleTimeString(undefined, { timeZone: 'UTC', hour12: false }) + ' UTC';
    if(issFailures === 0) clearTimeout(pollIss._staleTimer);
    pollIss._staleTimer = setTimeout(markIssStale, ISS_STALE_MS);

    marker.setLatLng([d.latitude, d.longitude]);
    // first fix: show the station instead of an arbitrary world view, unless follow is on
    if(!map._framed){
      map._framed = true;
      if(!IssTrack.on) map.setView([d.latitude, d.longitude], Math.max(map.getZoom(), 2), { animate: false });
    }
    IssTrack.apply();   // no-op unless the follow toggle is on
    issTrail.push([d.latitude, d.longitude]);
    if(issTrail.length > 120) issTrail.shift();
    if(!map._trailLine){
      map._trailLine = L.polyline(issTrail, { color: '#4F8CFF', weight: 1.5, opacity: .55, dashArray: '4 6' }).addTo(map);
    } else map._trailLine.setLatLngs(issTrail);

    buildBrief();
  }catch(e){
    issFailures++;
    $('iss-status').textContent = lastIss
      ? 'Position feed hiccup — retrying (values shown are from the last good fix).'
      : 'Connecting to Where The ISS At… (retrying)';
    // after repeated failures back off to ~30s polls instead of hammering every 8s
    if(issFailures === 3){
      clearInterval(pollIss._interval);
      pollIss._interval = setInterval(pollIss, 30000);
      pollIss._backedOff = true;
    }
  }
  // a successful poll restores normal 8s cadence after a backoff
  if(issFailures === 0 && pollIss._backedOff){
    clearInterval(pollIss._interval);
    pollIss._interval = setInterval(pollIss, 8000);
    pollIss._backedOff = false;
  }
}
pollIss();
pollIss._interval = setInterval(pollIss, 8000);

export function lastIssOf(){ return lastIss; }
export { IssTrack, IssFeed, applyBasemap, refreshMapSoon, refreshEventsMapSoon, ensureEventsMap, refreshEventsMapSize };
export function initMapOnce(){ initMap(); }
export function getEventsMap(){ return eventsMap; }
