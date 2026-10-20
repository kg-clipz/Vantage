import { Eonet } from './spaceweather.js';
import { Timeline } from './timeline.js';
import { toast } from '../ui.js';
/* ================================================================
   Vantage — js/modules/storms.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */

import { $, Store, httpJSON, esc, fmt, num, isoDate, ApiCache, SampleData } from '../api.js';
/* ================================================================
   Tropical systems — NHC track, forecast cone and Saffir–Simpson filters
   ================================================================ */
const Storms = {
  /* The obvious source — www.nhc.noaa.gov/CurrentStorms.json — cannot be used from a page at
     all: NOAA's web host sends no Access-Control-Allow-Origin header, so the browser discards
     the response however correct the request is (verified against the live endpoint). The same
     data *is* available over CORS on NOAA's ArcGIS service, where one query against the
     Forecast Points layer returns every active cyclone with its current position (tau = 0),
     its forecast points out to 120 h, its category, winds, pressure and movement. That single
     query is the source used here; the track and cone come from two sibling layers, fetched
     only when a viewer actually asks for a forecast path. */
  GIS: 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer',
  LAYERS: { track: 6, cone: 7 },
  POINTS: 5,
  TTL: 30 * 60 * 1000,
  /* the published Saffir–Simpson scale, in knots of maximum sustained wind — the same units
     and the same boundaries the NHC uses, so "Cat 3" here means what it means there */
  CATS: [
    { id: 'td', l: 'Depression',  c: '#6EE7B7', min: 0,   max: 34 },
    { id: 'ts', l: 'Trop. storm', c: '#4F8CFF', min: 34,  max: 64 },
    { id: 'c1', l: 'Cat 1',       c: '#FFB454', min: 64,  max: 83 },
    { id: 'c2', l: 'Cat 2',       c: '#F59E0B', min: 83,  max: 96 },
    { id: 'c3', l: 'Cat 3',       c: '#FF6B6B', min: 96,  max: 113 },
    { id: 'c4', l: 'Cat 4',       c: '#DC2626', min: 113, max: 137 },
    { id: 'c5', l: 'Cat 5',       c: '#A78BFA', min: 137, max: 1e6 }
  ],
  active: [], byKey: {}, sel: null, paths: true, gis: null, overlay: null, drawn: null,
  isSample: false, isCached: false, why: '', busy: false,
  catOf(knots){
    const k = num(knots);
    if(k == null) return null;
    return this.CATS.filter(c => k >= c.min && k < c.max)[0] || this.CATS[this.CATS.length - 1];
  },
  /* `ssnum` is the NHC's own category number, so it is preferred; the wind speed is the
     fallback and the classification string the last resort. */
  catFor(st){
    const byId = id => this.CATS.filter(c => c.id === id)[0] || null;
    const n = num(st && st.ssnum);
    const cls = String((st && st.classification) || '').toLowerCase();
    if(n != null && n >= 1) return byId('c' + Math.min(5, Math.round(n))) || byId('c5');
    if(cls.indexOf('hurricane') >= 0) return byId('c1');
    if(cls.indexOf('tropical storm') >= 0 || cls.indexOf('subtropical storm') >= 0) return byId('ts');
    if(cls.indexOf('depression') >= 0 || cls.indexOf('cyclone') >= 0) return byId('td');
    return this.catOf(st && st.intensity) || byId('td');
  },
  /* EONET titles a storm "Hurricane Polo" or "Tropical Storm Fay" while the NHC's own record
     is just "Polo" / "Fay", so both sides are stripped of their storm-type words before they
     are compared. Nothing else is matched loosely — a wrong cone is worse than no cone. */
  norm(s){
    return String(s || '').toLowerCase()
      .replace(/\b(hurricane|typhoon|super typhoon|tropical storm|tropical depression|tropical cyclone|post-tropical cyclone|post-tropical storm|subtropical storm|subtropical depression|potential tropical cyclone|tropical disturbance|invest)\b/g, ' ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },
  keyOf(st){
    const basin = String((st && st.basin) || '').trim();
    const bin = String((st && st.binNumber) || '').trim();
    const nm = this.norm(st && st.name);
    return [basin, bin, nm].filter(Boolean).join('/') || String((st && st.id) || '');
  },
  index(){
    this.byKey = {};
    this.active.forEach(st => {
      const k = this.keyOf(st);
      st._key = k;
      st._cat = this.catFor(st);   // NHC's own category number when it publishes one
      this.byKey[k] = st;
      this.byKey[this.norm(st.name)] = st;
      if(st.id) this.byKey[st.id] = st;
    });
  },
  forEvent(ev){
    if(!ev || Eonet.catId(ev) !== 'severeStorms') return null;
    const nm = this.norm(ev.title);
    if(!nm) return null;
    let hit = this.byKey[nm] || null;
    if(!hit){
      const cands = this.active.filter(st => {
        const sn = this.norm(st.name);
        return sn.length >= 3 && (sn === nm || nm.endsWith(' ' + sn) || nm.startsWith(sn + ' ') || nm.indexOf(sn) >= 0);
      });
      hit = cands[0] || null;
    }
    return hit;
  },
  hidden(ev){
    if(!this.sel) return false;
    const st = this.forEvent(ev);
    if(!st) return false;                       // an unmatched storm is never hidden by this control
    return this.sel.indexOf(st._cat ? st._cat.id : 'td') < 0;
  },
  /* One query carries the whole picture, so the storm list is built from its features rather
     than from a second endpoint. `tau` is the forecast hour — 0 is the current position — and
     every field below is NHC's own, untransformed. */
  /* NHC writes 9999 into any field it has no value for — direction and speed on a drifting
     system, mean sea-level pressure on a forecast point. Passed through unchanged that prints
     "moving 9999° at 9,999 kt", so the sentinel is converted to a genuine absence once, here,
     and every panel downstream sees null and says "not reported" instead. */
  val(v){
    const n = num(v);
    return (n == null || Math.abs(n) >= 999) ? null : n;
  },
  fromFeatures(features){
    const groups = {};
    (Array.isArray(features) ? features : []).forEach(f => {
      const p = (f && f.properties) || {};
      const c = (f && f.geometry && f.geometry.coordinates) || null;
      if(!c || !isFinite(c[0]) || !isFinite(c[1])) return;
      const name = String(p.stormname || '').trim();
      if(!name) return;
      const key = name + '|' + String(p.basin || '').trim();
      const g = groups[key] || (groups[key] = { name: name, pts: [] });
      g.pts.push({
        tau: num(p.tau) || 0,
        label: String(p.datelbl || ''),
        wind: this.val(p.maxwind),
        gust: this.val(p.gust),
        mslp: this.val(p.mslp),
        ssnum: this.val(p.ssnum),
        cls: String(p.tcdvlp || p.dvlbl || p.stormtype || ''),
        lat: Number(c[1]), lon: Number(c[0])
      });
      g.props = p;
    });
    return Object.keys(groups).map(k => {
      const g = groups[k];
      const pts = g.pts.slice().sort((a, b) => a.tau - b.tau);
      const now = pts[0];
      const p = g.props || {};
      const la = now.lat, lo = now.lon;
      return {
        id: 'nhc:' + k,
        name: String(p.stormname || g.name).trim(),
        basin: String(p.basin || '').trim(),
        binNumber: String(p.binnumber || '').trim(),
        classification: now.cls,
        ssnum: now.ssnum,
        intensity: now.wind,
        gust: now.gust,
        pressure: now.mslp,
        latitudeNumeric: la,
        longitudeNumeric: lo,
        latitude: la != null ? Math.abs(la).toFixed(1) + (la >= 0 ? 'N' : 'S') : '',
        longitude: lo != null ? Math.abs(lo).toFixed(1) + (lo >= 0 ? 'E' : 'W') : '',
        advNum: p.advisnum != null ? String(p.advisnum) : '',
        issuance: String(p.advdate || ''),
        movementDir: this.val(p.tcdir) != null ? String(this.val(p.tcdir)) : '',
        movementSpeed: this.val(p.tcspd),
        forecast: pts
      };
    }).sort((a, b) => (num(b.intensity) || 0) - (num(a.intensity) || 0));
  },
  async load(){
    if(this.busy) return;
    this.busy = true;
    const note = $('storm-note');
    if(note) note.textContent = 'querying NHC…';
    this.why = ''; this.isSample = false; this.isCached = false;
    try{
      const gj = await httpJSON(this.GIS + '/' + this.POINTS + '/query?where=1%3D1&outFields=*&outSR=4326&f=geojson', { timeoutMs: 22000 });
      const list = this.fromFeatures(gj && gj.features);
      this.active = list;
      ApiCache.set('nhc-storms', list);
    }catch(e){
      this.why = e && e.timedOut ? 'NOAA\u2019s tropical-cyclone service did not answer in time' : 'NOAA\u2019s tropical-cyclone service could not be reached';
      const hit = ApiCache.get('nhc-storms');
      if(hit && Array.isArray(hit.data) && hit.data.length && hit.age < this.TTL){
        this.active = hit.data; this.isCached = true;
      } else {
        this.active = (SampleData.storms ? SampleData.storms() : []);
        this.isSample = true;
      }
    }
    this.active.forEach(st => { st._cat = this.catFor(st); });
    this.index();
    this.busy = false;
    this.fillChips();
    this.paintNote();
    /* the markers carry storm identity now, so they are redrawn with it */
    try{ if(typeof Eonet !== 'undefined' && Eonet.events.length) Eonet.drawMarkers(); }catch(e){}
    Timeline.bump();
  },
  paintNote(){
    const note = $('storm-note');
    if(!note) return;
    if(!this.active.length){
      note.innerHTML = `No tropical cyclone is active in the NHC\u2019s basins right now — the filter above populates the moment one forms. <a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener noreferrer">NHC ↗</a>`;
      return;
    }
    const n = this.active.length;
    let txt = `${n} active system${n === 1 ? '' : 's'} · NHC`;
    if(this.isCached){
      const hit = ApiCache.get('nhc-storms');
      txt = `${this.why} — showing the cached list from ${hit ? new Date(hit.at).toISOString().slice(11, 16) : '—'} UTC`;
    }
    if(this.isSample) txt = `${this.why} — showing built-in sample storms`;
    const worst = this.active.slice().sort((a, b) => (num(b.intensity) || 0) - (num(a.intensity) || 0))[0];
    if(worst && worst._cat) txt += ` · strongest ${esc(worst.name)} (${worst._cat.l}, ${fmt(num(worst.intensity) || 0, 0)} kt)`;
    note.innerHTML = txt + (this.isCached || this.isSample ? ' ' + SampleData.badge(this.isSample ? 'sample' : 'cached') : '');
  },
  counts(){
    const c = {};
    this.active.forEach(st => { const id = st._cat ? st._cat.id : 'td'; c[id] = (c[id] || 0) + 1; });
    return c;
  },
  isSel(id){ return !this.sel || this.sel.indexOf(id) >= 0; },
  fillChips(){
    const el = $('storm-cats');
    if(!el) return;
    const counts = this.counts();
    const cats = this.CATS.filter(c => counts[c.id]);
    if(!cats.length){ el.innerHTML = '<span style="font-size:11.5px;color:var(--text-3)">none active</span>'; return; }
    el.innerHTML = cats.map(c =>
      `<button class="storm-chip" data-scat="${c.id}" aria-pressed="${this.isSel(c.id)}" title="Show or hide ${esc(c.l)} on the map">`
      + `<span class="sw" style="background:${c.c}"></span>${esc(c.l)}<span class="n">${counts[c.id]}</span></button>`).join('');
    el.querySelectorAll('[data-scat]').forEach(b => b.addEventListener('click', () => this.toggleCat(b.dataset.scat)));
  },
  toggleCat(id){
    if(!this.sel) this.sel = this.CATS.filter(c => this.counts()[c.id]).map(c => c.id);
    const i = this.sel.indexOf(id);
    if(i >= 0) this.sel.splice(i, 1); else this.sel.push(id);
    if(!this.sel.length) this.sel = null;
    this.fillChips();
    this.paintNote();
    Eonet.drawMarkers();
  },
  setPaths(v){
    this.paths = !!v;
    const b = $('storm-paths');
    if(b){
      b.textContent = 'forecast paths: ' + (this.paths ? 'on' : 'off');
      b.setAttribute('aria-pressed', this.paths ? 'true' : 'false');
      b.classList.toggle('on', true);
    }
    if(!this.paths) this.clearOverlay();
    else if(this.drawn) this.show(this.drawn);
  },
  async gisData(){
    if(this.gis) return this.gis;
    const hit = ApiCache.get('nhc-gis');
    if(hit && hit.data && hit.age < this.TTL){ this.gis = hit.data; return this.gis; }
    const out = {};
    for(const name of ['track', 'cone']){
      try{
        const gj = await httpJSON(this.GIS + '/' + this.LAYERS[name] + '/query?where=1%3D1&outFields=*&outSR=4326&f=geojson', { timeoutMs: 22000 });
        if(gj && Array.isArray(gj.features) && gj.features.length) out[name] = gj.features;
      }catch(e){ /* a missing cone is not a broken page — the observed track still draws */ }
    }
    if(out.points || out.track || out.cone){ this.gis = out; ApiCache.set('nhc-gis', out); }
    return this.gis;
  },
  featuresFor(gis, st){
    if(!gis || !st) return {};
    const want = this.norm(st.name);
    const pick = arr => (arr || []).filter(f => {
      const p = (f && f.properties) || {};
      const nm = this.norm(p.stormname);
      if(!nm) return false;
      if(nm === want) return true;
      /* the points layer labels the storm "Tropical Depression Fay" while the track says
         just "Fay", and the basin letter disambiguates two basins sharing a name */
      return (nm.endsWith(' ' + want) || nm.startsWith(want + ' ')) && (!st.basin || String(p.basin || '').toUpperCase() === String(st.basin).toUpperCase());
    });
    return { points: pick(gis.points), track: pick(gis.track), cone: pick(gis.cone) };
  },
  clearOverlay(){
    const m = ensureEventsMap();
    if(this.overlay && m){ try{ m.removeLayer(this.overlay); }catch(e){} }
    this.overlay = null;
    this.marker = null;
    this.drawn = null;
  },
  /* Clicking a storm marker draws its *observed* track (EONET's own timestamped fixes) and,
     when the forecast switch is on, the NHC's forecast track and cone of uncertainty on top. */
  async show(key){
    const m = ensureEventsMap();
    const st = this.byKey[key] || null;
    if(!m || !st) return;
    if(this.drawn === key && this.overlay){
      /* already drawn — a second click re-opens the storm's own popup rather than paying for
         the same cone twice */
      try{ if(this.marker) this.marker.openPopup(); }catch(e){}
      return;
    }
    this.clearOverlay();
    const ll = [num(st.latitudeNumeric), num(st.longitudeNumeric)];
    if(ll[0] == null || ll[1] == null || !isFinite(ll[0]) || !isFinite(ll[1])) return;
    const cat = st._cat || this.catOf(st.intensity) || this.CATS[0];
    const g = this.overlay = L.layerGroup();
    this.drawn = key;
    /* observed track from the matching EONET event, if one is on the map */
    const ev = Eonet.events.filter(x => this.forEvent(x) === st)[0] || null;
    const pts = [];
    if(ev){
      (ev.geometry || []).forEach(p => {
        if(!p || p.type !== 'Point' || !Array.isArray(p.coordinates)) return;
        const la = num(p.coordinates[1]), lo = num(p.coordinates[0]);
        if(la != null && lo != null) pts.push([la, lo]);
      });
    }
    if(pts.length > 1){
      L.polyline(pts, { color: cat.c, weight: 2, opacity: .75, dashArray: '5,5' }).addTo(g)
        .bindTooltip('Observed track · EONET fixes', { sticky: true });
    }
    let fc = { track: [], cone: [] };
    if(this.paths){
      const gis = await this.gisData();
      fc = this.featuresFor(gis, st);
      fc.cone.forEach(f => {
        if(!f.geometry || !f.geometry.coordinates) return;
        L.geoJSON(f, { style: { color: cat.c, weight: 1.2, opacity: .85, fillColor: cat.c, fillOpacity: .16 } })
          .addTo(g).bindTooltip('Forecast cone of uncertainty · NHC', { sticky: true });
      });
      fc.track.forEach(f => {
        if(!f.geometry || !f.geometry.coordinates) return;
        const latlngs = (f.geometry.coordinates || []).map(c => [num(c[1]), num(c[0])]).filter(p => p[0] != null && p[1] != null);
        if(latlngs.length > 1) L.polyline(latlngs, { color: cat.c, weight: 3, opacity: .95 }).addTo(g)
          .bindTooltip('Forecast track · NHC', { sticky: true });
      });
    }
    g.addTo(m);
    /* current position, drawn last so it sits on top of the tracks */
    const mk = this.marker = L.circleMarker(ll, { radius: 11, color: cat.c, weight: 2.5, fillColor: cat.c, fillOpacity: .3 }).addTo(g);
    mk.bindPopup(this.popupHtml(st, ev, fc), { maxWidth: 340 }).openPopup();
    if(m.setView) m.setView(ll, Math.max(m.getZoom(), 4));
    toast(`${st.name} · ${cat.l} — ${this.paths ? 'forecast path and cone drawn' : 'observed track drawn (forecast paths are off)'}`);
  },
  /* Forecast rows come from the storm's own point set, so the times are NHC's labels and the
     intensities are NHC's figures — nothing here is interpolated by the page. */
  forecastRows(st){
    const pts = (st.forecast || []).filter(p => p.tau > 0);
    if(!pts.length) return '';
    return '<div class="fc-title">Forecast points · NHC, out to 120 h</div>' + pts.map(p => {
      const c = this.catFor({ ssnum: p.ssnum, classification: p.cls, intensity: p.wind });
      return `<span class="fc-row">T+${fmt(p.tau, 0)}h${p.label ? ' · ' + esc(p.label) : ''} · ${fmt(p.wind, 0)} kt`
        + (p.gust != null ? ' (gust ' + fmt(p.gust, 0) + ')' : '')
        + ' · ' + esc(c ? c.l : '—') + (p.mslp != null ? ' · ' + fmt(p.mslp, 0) + ' mb' : '') + '</span>';
    }).join('');
  },
  popupHtml(st, ev, fc){
    const cat = st._cat || this.CATS[0];
    const ll = [num(st.latitudeNumeric), num(st.longitudeNumeric)];
    const advis = st.advNum ? 'advisory ' + esc(st.advNum) : '';
    const move = [st.movementDir ? 'moving ' + esc(st.movementDir) + '°' : '', num(st.movementSpeed) != null ? 'at ' + fmt(st.movementSpeed, 0) + ' kt' : ''].filter(Boolean).join(' ');
    let out = `<div class="ev-pop storm-pop"><b>${esc(st.name || 'Tropical system')}</b>`
      + `<span>${esc(st.classification || '')} · ${fmt(num(st.intensity) || 0, 0)} kt sustained${num(st.pressure) != null ? ' · ' + fmt(st.pressure, 0) + ' mb' : ''}</span>`
      + `<span>${ll[0].toFixed(1)}°, ${ll[1].toFixed(1)}° · ${esc(GeoTools.short(ll[0], ll[1]))}</span>`
      + (move ? `<span>${move}</span>` : '')
      + `<span class="cat-badge" style="color:${cat.c};border-color:${cat.c}">${esc(cat.l)}</span>`
      + (advis ? `<span>${advis} · issued ${esc(st.issuance || '—')}</span>` : '');
    if((st.forecast || []).length > 1){
      out += this.forecastRows(st);
      if(!(fc && (fc.cone.length || fc.track.length))) out += '<span>the cone and track layers returned nothing for this system on this pass</span>';
    } else if(this.paths){
      out += '<span>no forecast points were published for this system</span>';
    }
    if(ev && ev.sources && ev.sources[0]) out += `<span><a href="${esc(ev.sources[0].url)}" target="_blank" rel="noopener">${esc(ev.sources[0].id || 'source')} ↗</a></span>`;
    out += `<span><a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">nhc.noaa.gov ↗</a>`
      + ` · <button class="mini" data-storm-clear="1">clear path</button></span></div>`;
    return out;
  }
};
/* the popup's own clear button lives inside Leaflet's popup DOM, so it is delegated */
document.addEventListener('click', e => {
  const b = e.target && e.target.closest ? e.target.closest('[data-storm-clear]') : null;
  if(!b) return;
  Storms.clearOverlay();
  toast('Forecast path cleared');
});
SampleData.storms = () => ([
  { id: 'sample-al1', name: 'Sample Storm', classification: 'HU', intensity: '85', pressure: '980', latitudeNumeric: 18.4, longitudeNumeric: -52.1, basin: 'AL', advNum: '7', movementDir: '290', movementSpeed: '12', latitude: '18.4N', longitude: '52.1W', issuance: 'sample', _sample: true },
  { id: 'sample-wp2', name: 'Sample Depression', classification: 'TD', intensity: '30', pressure: '1004', latitudeNumeric: 14.2, longitudeNumeric: 131.5, basin: 'WP', advNum: '3', movementDir: '315', movementSpeed: '8', latitude: '14.2N', longitude: '131.5E', issuance: 'sample', _sample: true }
]);

export { Storms };
