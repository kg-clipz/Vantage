import { Chime } from '../audio.js';
import { GeoTools } from './geotools.js';
import { Timeline } from './timeline.js';
import { Charts } from './charts.js';
import { Storms } from './storms.js';
import { utcStampPublic as utcStamp } from './mission.js';
import { ensureEventsMap } from './iss.js';
import { toast, showView } from '../ui.js';
/* ================================================================
   Vantage — js/modules/spaceweather.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */
import { $, Store, httpJSON, esc, fmt, num, isoDate, SampleData, ApiCache, nasaFetch, staggeredNasaFetch, Seq, Retry } from '../api.js';
/* ================================================================
   Space weather — NASA DONKI (flares, CMEs, geomagnetic storms)
   ================================================================ */
const Donki = {
  WINDOW_DAYS: 30,
  RANKS: { A: 1, B: 2, C: 3, M: 4, X: 5 },
  events: [],
  usingSample: false,
  range(){
    const end = new Date(), start = new Date(end.getTime() - this.WINDOW_DAYS * 86400000);
    return { start: isoDate(start), end: isoDate(end) };
  },
  url(kind, r){
    return `https://api.nasa.gov/DONKI/${kind}?startDate=${r.start}&endDate=${r.end}&api_key=${encodeURIComponent(getNasaKey())}`;
  },
  async one(kind, r){
    try{
      const d = await staggeredNasaFetch(this.url(kind, r), { label: 'DONKI ' + kind, timeoutMs: 15000 });
      return { data: Array.isArray(d) ? d : [] };
    }catch(e){
      // a throttle or a dead network means "use the samples"; anything else is a real error
      return { soft: !!(e && (e.rateLimited || e.network || e.timedOut)), err: e };
    }
  },
  hhmm(iso){ return iso && String(iso).length >= 16 ? String(iso).slice(11, 16) : '—'; },
  rank(cls){ const m = /^([ABCMX])/i.exec(String(cls || '').trim()); return m ? m[1].toUpperCase() : null; },
  size(cls){ const m = /^[ABCMX]([\d.]+)/i.exec(String(cls || '').trim()); return m ? Number(m[1]) : 0; },
  rel(iso){
    if(!iso) return '—';
    const h = Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
    if(!isFinite(h)) return '—';
    return h < 1 ? 'just now' : h < 48 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  },
  norm(kind, arr){
    const list = Array.isArray(arr) ? arr : [];
    if(kind === 'FLR') return list.map(f => ({
      kind: 'FLR', id: f.flrID || ('flr-' + (f.peakTime || f.beginTime)), time: f.peakTime || f.beginTime || '',
      cls: f.classType || '', loc: f.sourceLocation || '', ar: f.activeRegionNum || '—',
      title: 'Solar flare' + (f.classType ? ' · ' + f.classType : ''),
      detail: `Active region ${f.activeRegionNum || '—'} · peaked ${this.hhmm(f.peakTime || f.beginTime)} UTC${f.sourceLocation ? ' · ' + f.sourceLocation : ''}`
    }));
    if(kind === 'GST') return list.map(g => {
      const kps = Array.isArray(g.allKpIndex) ? g.allKpIndex : [];
      const kp = kps.reduce((m, k) => Math.max(m, Number(k && k.kpIndex) || 0), 0);
      return {
        kind: 'GST', id: g.gstID || ('gst-' + g.startTime), time: g.startTime || '', kp: kp,
        title: 'Geomagnetic storm' + (kp ? ' · Kp ' + kp : ''),
        detail: `${kps.length || 'no'} Kp observation${kps.length === 1 ? '' : 's'} · began ${this.hhmm(g.startTime)} UTC`
      };
    });
    if(kind === 'CME') return list.map(c => {
      const analyses = Array.isArray(c.cmeAnalyses) ? c.cmeAnalyses : [];
      const a = analyses.find(x => x && x.isMostAccurate) || analyses[0] || {};
      return {
        kind: 'CME', id: c.activityID || ('cme-' + c.startTime), time: c.startTime || '', speed: Number(a.speed) || 0,
        title: 'Coronal mass ejection' + (a.type ? ' · type ' + a.type : ''),
        detail: `${a.speed ? fmt(a.speed, 0) + ' km/s' : 'speed not modelled'} · origin ${c.sourceLocation || '—'} · ${this.hhmm(c.startTime)} UTC`
      };
    });
    return [];
  },
  async load(){
    const token = Seq.next('donki');
    const r = this.range();
    $('donki-note').textContent = `querying DONKI · ${r.start} → ${r.end}…`;
    const sample = SampleData.donki();
    const out = { FLR: null, CME: null, GST: null };
    let soft = false, hard = 0;
    for(const kind of ['FLR', 'CME', 'GST']){
      // once the key is clearly throttled, stop spending the remaining requests on it
      if(soft){ out[kind] = sample[kind]; continue; }
      const res = await this.one(kind, r);
      if(Seq.isStale('donki', token)) return;
      if(res.data){ out[kind] = res.data; continue; }
      if(res.soft) soft = true; else hard++;
      out[kind] = sample[kind];
    }
    if(hard === 3 && !soft){
      $('donki-list').innerHTML = Retry.card('DONKI did not answer for this window.', 'donki', () => this.load());
      $('donki-note').textContent = 'failed';
      return;
    }
    this.usingSample = soft;
    this.events = [].concat(this.norm('FLR', out.FLR), this.norm('CME', out.CME), this.norm('GST', out.GST))
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    this.render();
  },
  render(){
    const evs = this.events;
    const flares = evs.filter(e => e.kind === 'FLR');
    const storms = evs.filter(e => e.kind === 'GST');
    const cmes = evs.filter(e => e.kind === 'CME');
    const strongest = flares.slice().sort((a, b) => ((this.RANKS[this.rank(b.cls)] || 0) - (this.RANKS[this.rank(a.cls)] || 0)) || (this.size(b.cls) - this.size(a.cls)))[0];
    const maxKp = storms.reduce((m, s) => Math.max(m, Number(s.kp) || 0), 0);
    const fastest = cmes.slice().sort((a, b) => (b.speed || 0) - (a.speed || 0))[0];
    const r = this.range();

    $('donki-k-flares').textContent = flares.length;
    $('donki-k-flares-sub').textContent = flares.length ? `latest ${flares[0].cls || '—'} · ${this.rel(flares[0].time)}` : 'no flares in window';
    $('donki-k-strongest').textContent = strongest ? (strongest.cls || '—') : '—';
    $('donki-k-strongest-sub').textContent = strongest ? `${this.rel(strongest.time)}${strongest.loc ? ' · ' + strongest.loc : ''}` : 'quiet window';
    $('donki-k-gst').textContent = storms.length;
    $('donki-k-gst-sub').textContent = storms.length ? `peak Kp ${maxKp} · ${this.rel(storms[0].time)}` : 'no storms — magnetosphere quiet';
    $('donki-k-cme').textContent = cmes.length;
    $('donki-k-cme-sub').textContent = fastest ? `fastest ${fmt(fastest.speed, 0)} km/s` : 'none modelled';
    $('donki-meta').innerHTML = `DONKI · ${r.start} → ${r.end}${this.usingSample ? SampleData.badge('sample') : ''}`;
    $('donki-note').textContent = this.usingSample
      ? 'live DONKI feed rate-limited — showing built-in sample events'
      : 'DONKI responded — this window is live';
    this.renderList();
    this.buildChart();
    SolarDisk.render();   // the locator is driven by the same flare set
    $('badge-weather').textContent = this.events.length;   // Earth-side hazards have their own badge now
    Chime.checkSpaceWeather(this.events);
  },
  renderList(){
    const filter = $('donki-filter') ? $('donki-filter').value : 'all';
    const rows = this.events.filter(e => filter === 'all' || e.kind === filter);
    const host = $('donki-list');
    if(!rows.length){
      host.innerHTML = '<div class="empty">No events of that type in the last ' + this.WINDOW_DAYS + ' days — the Sun is quiet.</div>';
      return;
    }
    const cls = { FLR: 'flr', GST: 'gst', CME: 'cme' };
    host.innerHTML = rows.slice(0, 60).map(e => `
      <div class="sev-row">
        <div class="when">${esc(String(e.time).slice(0, 10))}<br>${esc(this.hhmm(e.time))} UTC</div>
        <div class="what">
          <div class="t">${esc(e.title)}</div>
          <div class="s">${esc(e.detail)}</div>
        </div>
        <div class="act">
          <span class="type-chip ${cls[e.kind] || ''}">${esc(e.kind)}</span>
          <a class="mini" href="https://ccmc.gsfc.nasa.gov/tools/DONKI/" target="_blank" rel="noopener" aria-label="Open this event in NASA's DONKI tool">DONKI ↗</a>
        </div>
      </div>`).join('')
      + (rows.length > 60 ? `<div class="empty">${rows.length - 60} older events not shown — filter by type to narrow this list.</div>` : '');
  },
  buildChart(){
    const flares = this.events.filter(e => e.kind === 'FLR');
    if(!flares.length) return;
    const t = Charts.theme();
    const classes = ['B', 'C', 'M', 'X'];
    const counts = classes.map(c => flares.filter(f => this.rank(f.cls) === c).length);
    Charts.make('chart-donki', {
      type: 'bar',
      data: {
        labels: classes.map(c => c + '-class'),
        datasets: [{ label: 'flares (30d)', data: counts, backgroundColor: [t.ok, t.accent, t.warm, t.hot], borderRadius: 5 }]
      },
      options: {
        scales: { x: { grid: { display: false } }, y: { grid: { color: t.grid }, ticks: { precision: 0 }, beginAtZero: true } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.y} flare${c.parsed.y === 1 ? '' : 's'} in the window` } } }
      }
    });
  }
};

/* ================================================================
   Natural events — NASA EONET (key-less, CORS-open)
   ================================================================ */
const Eonet = {
  CATS: {
    wildfires:           { l: 'Wildfires',            c: '#FF8A3D' },
    severeStorms:        { l: 'Severe storms',        c: '#4F8CFF' },
    volcanoes:           { l: 'Volcanoes',            c: '#FF6B6B' },
    seaLakeIce:          { l: 'Sea & lake ice',       c: '#6EE7B7' },
    icebergs:            { l: 'Icebergs',             c: '#A5F3FC' },
    drought:             { l: 'Drought',              c: '#C9A227' },
    dustHaze:            { l: 'Dust & haze',          c: '#C08A5A' },
    floods:              { l: 'Floods',               c: '#22D3EE' },
    landslides:          { l: 'Landslides',           c: '#8B7355' },
    manmade:             { l: 'Man-made',             c: '#94A3B8' },
    snow:                { l: 'Snow',                 c: '#E2E8F0' },
    temperatureExtremes: { l: 'Temperature extremes', c: '#F472B6' },
    waterColor:          { l: 'Water colour',         c: '#34D399' }
  },
  events: [], byId: {}, layer: null, visible: true, PEND: null,
  /* filter state: `sel` is null for “everything”, otherwise the list of category ids on the
     map. Null rather than a pre-filled list so a window change starts fully selected. */
  sel: null, scale: {}, isSample: false, isCached: false, cachedAt: null,
  DAYS: 30, GET: 'https://eonet.gsfc.nasa.gov/api/v3/events',
  /* A stored copy is a fallback, not a licence to serve yesterday's wildfires: once it passes
     the TTL it counts as expired and the view falls through to sample data with an honest
     notice. One day matches how often EONET's event set is worth re-reading. */
  CACHE_TTL: 24 * 60 * 60 * 1000,
  /* The window is derived from the *system clock* every time a request is built rather than
     being written into the query, so the feed rolls forward on its own each day — a
     hard-coded pair of dates would quietly stop returning anything as soon as it aged out. */
  window(){
    const end = new Date();
    const start = new Date(end.getTime() - this.DAYS * 86400000);
    return { start: isoDate(start), end: isoDate(end) };
  },
  url(){
    const w = this.window();
    return this.GET + '?status=open&limit=250&days=' + this.DAYS + '&start=' + w.start + '&end=' + w.end;
  },
  cacheKey(){ return 'eonet:' + this.DAYS; },
  cat(id){ return this.CATS[id] || { l: String(id || 'other').replace(/([A-Z])/g, ' $1').trim(), c: '#94A3B8' }; },
  catId(ev){ return (ev && ev.categories && ev.categories[0] && ev.categories[0].id) || 'manmade'; },
  /* ---- category filtering ---- */
  allCats(){ return this.counts().map(c => c[0]); },
  isSel(id){ return !this.sel || this.sel.indexOf(id) >= 0; },
  visibleEvents(){ return this.events.filter(ev => this.isSel(this.catId(ev))); },
  toggleCat(id){
    if(!this.sel) this.sel = this.allCats();
    const i = this.sel.indexOf(id);
    if(i >= 0) this.sel.splice(i, 1); else this.sel.push(id);
    if(!this.sel.length) this.sel = null;   // never accidentally leave the map empty
    this.afterFilter();
  },
  selectAll(){ this.sel = null; this.afterFilter(); },
  afterFilter(){
    this.drawMarkers();
    this.renderLegend();
    this.renderList();
    this.fillChips();
    this.tiles();
    this.buildChart();
    const evs = this.visibleEvents();
    if($('eonet-note')) $('eonet-note').textContent = `showing ${evs.length} of ${this.events.length} events · click a marker for details`;
  },
  latest(ev){
    const g = ((ev && ev.geometry) || []).filter(Boolean);
    return g.length ? g[g.length - 1] : null;
  },
  coords(g){
    if(!g || !g.coordinates) return null;
    if(g.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) return [Number(g.coordinates[1]), Number(g.coordinates[0])];
    // polygons and lines: average the vertices — plenty to drop a marker in the right region
    const flat = [];
    const walk = v => { if(Array.isArray(v) && typeof v[0] === 'number') flat.push(v); else if(Array.isArray(v)) v.forEach(walk); };
    walk(g.coordinates);
    const pts = flat.filter(p => isFinite(p[0]) && isFinite(p[1]));
    if(!pts.length) return null;
    return [pts.reduce((s, p) => s + p[1], 0) / pts.length, pts.reduce((s, p) => s + p[0], 0) / pts.length];
  },
  init(){
    const m = ensureEventsMap();
    if(typeof L === 'undefined' || !m) return false;
    if(!this.layer) this.layer = L.layerGroup();
    if(this.visible && !m.hasLayer(this.layer)) this.layer.addTo(m);
    return true;
  },
  /* (re)bind the event layers to whichever events map now exists and redraw */
  attach(){
    const m = ensureEventsMap();
    if(!m) return;
    if(this.layer){ try{ this.layer.remove(); }catch(e){} }
    this.layer = L.layerGroup();
    if(this.visible) this.layer.addTo(m);
    this.drawMarkers();
    this.renderLegend();
  },
  async load(days){
    if(days) this.DAYS = Number(days);
    const token = Seq.next('eonet');
    const w = this.window();
    this.notice('');
    $('eonet-note').textContent = `querying EONET · ${w.start} → ${w.end}…`;
    let list = null, isSample = false, isCached = false, why = '';
    try{
      // EONET is its own service with no key and no shared api.nasa.gov quota
      const d = await nasaFetch(this.url(), { label: 'EONET', timeoutMs: 15000 });
      if(Seq.isStale('eonet', token)) return;
      list = (d && d.events) || [];
      if(list.length) ApiCache.set(this.cacheKey(), list);
    }catch(e){
      if(Seq.isStale('eonet', token)) return;
      why = e && e.rateLimited ? 'EONET is throttling requests right now'
        : (e && e.timedOut ? 'EONET did not answer in time' : 'EONET could not be reached');
      list = null;
    }
    if(!Array.isArray(list) || !list.length){
      const hit = ApiCache.get(this.cacheKey());
      if(hit && Array.isArray(hit.data) && hit.data.length && hit.age < this.CACHE_TTL){
        list = hit.data; isCached = true; this.cachedAt = hit.at;   // a fresh stored copy beats an empty view
      } else {
        this.cachedAt = null;
        list = SampleData.eonet(); isSample = true;
      }
    } else {
      this.cachedAt = null;
    }
    this.events = list;
    this.sel = null;                     // a fresh window starts with every category visible
    this.render(isSample, isCached, why);
  },
  /* A notice, not an empty component: a throttled or unreachable feed is explained in plain
     language, with the retry and the fix (a personal key) attached to it. */
  notice(html){
    const el = $('eonet-notice');
    if(!el) return;
    el.innerHTML = html || '';
    el.hidden = !html;
    el.style.marginBottom = html ? '14px' : '';
  },
  render(isSample, isCached, why){
    this.isSample = !!isSample;
    this.isCached = !!isCached;
    this.init();
    this.computeScale();
    const w = this.window();
    const stamp = this.cachedAt ? new Date(this.cachedAt) : null;
    const when = stamp ? stamp.toISOString().slice(11, 16) + ' UTC' : '';
    const str = `${this.events.length} open events · ${w.start} → ${w.end} · key-less feed`;
    const meta = isCached ? str + SampleData.badge('cached') : (isSample ? str + SampleData.badge('sample') : str);
    $('eonet-meta').innerHTML = meta;
    if($('events-meta')) $('events-meta').innerHTML = meta;
    Retry.register('eonet', () => this.load());
    if(isCached){
      this.notice(`<div class="notice"><span class="n-ico">🗄</span><div>`
        + `<b>${esc(why || 'EONET is unavailable')} — showing the cached copy.</b> `
        + `These ${this.events.length} events were saved from the last successful request at <b>${when}</b> (${w.start} → ${w.end}), so the map and the numbers stay usable while the provider is down.`
        + `<span class="n-sub">The cache refreshes itself on the next successful request and expires after 24 hours; nothing here needs an API key.</span>`
        + `<div class="n-actions">${Retry.btn('eonet', '↻ retry the live feed')}</div></div></div>`);
      $('eonet-note').innerHTML = 'serving cached events · press retry for the live feed';
    } else if(isSample){
      this.notice(`<div class="notice bad"><span class="n-ico">📡</span><div>`
        + `<b>${esc(why || 'EONET could not be reached')}, and there is no cached copy for this window yet.</b> `
        + `The map below is populated with <b>built-in sample events</b> so the layout and controls stay testable — the numbers are illustrative, not real.`
        + `<span class="n-sub">EONET needs no key, so a retry usually clears this on its own.</span>`
        + `<div class="n-actions">${Retry.btn('eonet', '↻ retry now')}</div></div></div>`);
      $('eonet-note').innerHTML = 'EONET unreachable — showing built-in sample events';
    } else {
      this.notice('');
      $('eonet-note').innerHTML = `showing ${this.visibleEvents().length} of ${this.events.length} events · click a marker for details`;
    }
    this.drawMarkers();
    this.fillChips();
    this.renderList();
    this.renderLegend();
    this.tiles();
    this.buildChart();
    $('badge-events').textContent = this.events.length;
    Chime.checkEvents(this.events);
  },
  /* marker size is meaningful only when it compares like with like: EONET reports wildfires in
     acres and storms in knots, so the scale is computed per category against whichever unit
     that category uses. */
  computeScale(){
    const max = {}, unit = {};
    this.events.forEach(ev => {
      const g = this.latest(ev);
      const v = g && g.magnitudeValue != null ? num(g.magnitudeValue) : null;
      if(v == null || v <= 0) return;
      const cid = this.catId(ev);
      const u = String(g.magnitudeUnit || '').toLowerCase();
      if(unit[cid] && unit[cid] !== u) return;
      unit[cid] = u;
      max[cid] = Math.max(max[cid] || 0, v);
    });
    this.scale = max;
  },
  severity(ev){
    const g = this.latest(ev);
    const v = g && g.magnitudeValue != null ? num(g.magnitudeValue) : null;
    const top = this.scale[this.catId(ev)];
    if(v == null || !top) return 6;
    const share = Math.max(0, Math.min(1, v / top));
    return 5 + 4 * Math.sqrt(share);
  },
  tiles(){
    const evs = this.visibleEvents();
    $('eonet-k-count').textContent = fmt(evs.length, 0);
    $('eonet-k-count-sub').textContent = `of ${this.events.length} reported · past ${this.DAYS} days`;
    $('eonet-k-cats').textContent = fmt(this.counts().length, 0);
    $('eonet-k-cats-sub').textContent = this.sel ? `${this.sel.length} selected` : 'all categories shown';
    const top = this.counts().filter(c => this.isSel(c[0]))[0];
    $('eonet-k-top').textContent = top ? this.cat(top[0]).l : '—';
    $('eonet-k-top-sub').textContent = top ? `${top[1]} event${top[1] === 1 ? '' : 's'} in window` : 'nothing in window';
    let best = null;
    evs.forEach(ev => {
      const g = this.latest(ev);
      const v = g && g.magnitudeValue != null ? num(g.magnitudeValue) : null;
      if(v == null) return;
      if(!best || v > best.v) best = { v: v, u: g.magnitudeUnit || '', title: ev.title };
    });
    $('eonet-k-max').textContent = best ? fmt(best.v, 1) : '—';
    $('eonet-k-max-sub').textContent = best ? `${best.u || 'reported units'} · ${best.title.slice(0, 30)}` : 'no magnitudes reported';
  },
  drawMarkers(){
    if(!this.init() || !this.layer) return;
    this.layer.clearLayers();
    this.byId = {};
    this.stormOf = {};
    this.visibleEvents().forEach(ev => {
      /* a storm whose category the filter has switched off is not drawn at all — that control
         is a map filter, not a label in a side list */
      if(Storms.hidden(ev)) return;
      const g = this.latest(ev);
      const ll = this.coords(g);
      if(!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return;
      const cat = this.cat(this.catId(ev));
      const when = g && g.date ? String(g.date).slice(0, 10) : '';
      const mag = (g && g.magnitudeValue != null) ? `${fmt(g.magnitudeValue, 1)} ${g.magnitudeUnit || ''}`.trim() : '—';
      const src = (ev.sources && ev.sources[0]) || null;
      const mk = L.circleMarker(ll, { radius: this.severity(ev), color: cat.c, weight: 1.4, fillColor: cat.c, fillOpacity: .42, opacity: .9 });
      /* A tropical system that the NHC is tracking is a different kind of marker: clicking it
         is what draws the forecast track and cone, so it carries a tooltip that says so rather
         than the generic popup, which would cover the path the moment it was drawn. */
      const storm = Storms.forEvent(ev);
      if(storm){
        const sk = storm._key || storm.id;
        this.stormOf[ev.id] = sk;
        mk.on('click', () => Storms.show(sk));
        mk.bindTooltip(esc(ev.title) + ' · ' + esc(storm._cat ? storm._cat.l : 'tropical system') + ' — click for the forecast path', { direction: 'top', opacity: .95 });
      } else {
        mk.bindPopup(
          `<div class="ev-pop"><b>${esc(ev.title)}</b>`
          + `<span>${esc(cat.l)} · ${esc(GeoTools.short(ll[0], ll[1]))}</span>`
          + `<span>${ll[0].toFixed(2)}°, ${ll[1].toFixed(2)}° · started ${esc(when)}</span>`
          + `<span>magnitude ${esc(mag)}</span>`
          + (src ? `<span><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.id || 'source')} ↗</a></span>` : '')
          + `</div>`
        );
      }
      mk.addTo(this.layer);
      this.byId[ev.id] = mk;
    });
    /* a popup requested before the layer (re)built must be re-opened — focus() sets PEND */
    if(this.PEND && this.byId[this.PEND]){
      const want = this.PEND, mk = this.byId[want];
      mk.once('popupclose', () => { if(this.PEND === want) this.PEND = null; });
      setTimeout(() => { try{ if(this.byId[want]) this.byId[want].openPopup(); }catch(e){} }, 90);
    }
  },
  counts(){
    const c = {};
    this.events.forEach(ev => { const id = this.catId(ev); c[id] = (c[id] || 0) + 1; });
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  },
  renderLegend(){
    const el = $('events-legend');
    if(!el) return;
    const rows = this.counts().map(([id, n]) => {
      const on = this.isSel(id);
      return `<div class="lg-row click${on ? '' : ' dim'}" data-cat="${esc(id)}" role="button" tabindex="0" aria-pressed="${on}" title="Show or hide ${esc(this.cat(id).l)} on the map">`
        + `<span class="lg-dot" style="background:${this.cat(id).c}"></span>${esc(this.cat(id).l)}<span class="n">${n}</span></div>`;
    }).join('');
    el.innerHTML = `<h5>Natural events · EONET<button data-eonet-toggle aria-label="Toggle the natural events map layer">${this.visible ? 'hide' : 'show'}</button></h5>`
      + (this.visible ? (rows || '<div class="lg-row">no active events</div>') : '<div class="lg-row">layer hidden — press show</div>')
      + '<div class="lg-note"><b>Marker size</b> tracks each category\u2019s largest reported magnitude (wildfires in acres, storms in knots). Click a row to hide it.</div>';
    el.style.display = 'block';
    const btn = el.querySelector('[data-eonet-toggle]');
    if(btn) btn.addEventListener('click', () => this.setVisible(!this.visible));
    el.querySelectorAll('[data-cat]').forEach(r => {
      const go = () => this.toggleCat(r.dataset.cat);
      r.addEventListener('click', go);
      r.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); go(); } });
    });
  },
  setVisible(v){
    this.visible = v;
    const m = ensureEventsMap();
    if(m && this.layer){
      if(v && !m.hasLayer(this.layer)) this.layer.addTo(m);
      if(!v && m.hasLayer(this.layer)) m.removeLayer(this.layer);
    }
    this.renderLegend();
  },
  /* chips are the primary category control now — they filter the *map*, not just the list */
  fillChips(){
    const el = $('eonet-cats');
    if(!el) return;
    const chips = this.counts().map(([id, n]) =>
      `<button class="ev-chip" data-cat="${esc(id)}" aria-pressed="${this.isSel(id)}" title="Show or hide ${esc(this.cat(id).l)}">`
      + `<span class="sw" style="background:${this.cat(id).c}"></span>${esc(this.cat(id).l)}<span class="n">${n}</span></button>`).join('');
    el.innerHTML = `<button class="ev-chip" data-cat="__all" aria-pressed="${!this.sel}" title="Show every category"><span class="n">ALL</span></button>` + chips;
    el.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
      if(b.dataset.cat === '__all'){ this.selectAll(); return; }
      this.toggleCat(b.dataset.cat);
    }));
  },
  renderList(){
    const rows = this.visibleEvents().map(ev => {
      const g = this.latest(ev);
      return { ev: ev, g: g, ll: this.coords(g), catId: this.catId(ev), storm: Storms.forEvent(ev), when: g && g.date ? String(g.date).slice(0, 10) : '' };
    }).sort((a, b) => String(b.when).localeCompare(String(a.when)));
    const host = $('eonet-list');
    if(!rows.length){ host.innerHTML = '<div class="empty">No events in the selected categories right now — widen the window or re-enable a category.</div>'; return; }
    host.innerHTML = rows.slice(0, 40).map(r => `
      <div class="sev-row">
        <div class="when">${esc(r.when)}<br>${r.ll ? esc(r.ll[0].toFixed(1) + '°, ' + r.ll[1].toFixed(1) + '°') : 'no fix'}</div>
        <div class="what">
          <div class="t">${esc(r.ev.title)}</div>
          <div class="s">${r.g && r.g.magnitudeValue != null ? esc(fmt(r.g.magnitudeValue, 1) + ' ' + (r.g.magnitudeUnit || '')) + ' · ' : ''}${esc(r.ll ? GeoTools.short(r.ll[0], r.ll[1]) : 'position unknown')}</div>
        </div>
        <div class="act">
          <span class="type-chip" style="color:${this.cat(r.catId).c};border-color:${this.cat(r.catId).c}">${esc(this.cat(r.catId).l)}</span>
          ${r.storm ? `<span class="type-chip" style="color:${r.storm._cat ? r.storm._cat.c : 'var(--hot)'};border-color:${r.storm._cat ? r.storm._cat.c : 'var(--hot)'}">${esc(r.storm._cat ? r.storm._cat.l : 'storm')}</span>` : ''}
          ${r.ll ? `<button class="mini" data-locate="${esc(r.ev.id)}" aria-label="Show this event on the map">locate ↗</button>` : ''}
          ${r.storm ? `<button class="mini" data-storm="${esc(r.storm._key || r.storm.id)}" aria-label="Draw this storm's forecast path and cone on the map">path ↗</button>` : ''}
        </div>
      </div>`).join('')
      + (rows.length > 40 ? `<div class="empty">${rows.length - 40} more events — filter by category to narrow the list.</div>` : '');
    host.querySelectorAll('[data-locate]').forEach(b => b.addEventListener('click', () => this.focus(b.dataset.locate)));
    host.querySelectorAll('[data-storm]').forEach(b => b.addEventListener('click', () => { showView('events'); Storms.show(b.dataset.storm); }));
  },
  focus(id){
    // make sure the event's own category is switched on, otherwise its marker will not be drawn
    const ev = this.events.filter(x => x.id === id)[0];
    if(ev && !this.isSel(this.catId(ev))){
      if(!this.sel) this.sel = this.allCats();
      if(this.sel.indexOf(this.catId(ev)) < 0) this.sel.push(this.catId(ev));
      this.afterFilter();
    }
    showView('events');             // hazards have their own view now
    const mk0 = this.byId[id];
    if(!mk0){ toast('That event has no coordinates'); return; }
    this.setVisible(true);
    this.PEND = id;                 // survives a layer rebuild so the popup still lands
    const m = ensureEventsMap();
    if(!m){ this.PEND = null; toast('The events map could not be created'); return; }
    const ll = mk0.getLatLng();
    setTimeout(() => {
      refreshEventsMapSize();
      const mk = this.byId[id] || mk0;   // re-resolve: drawMarkers() may have replaced it
      mk.setLatLng(ll);
      m.setView(ll, 6, { animate: false });
      mk.openPopup();
      $('events-map').scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 320);
  },
  fitAll(){
    showView('events');
    this.setVisible(true);
    const m0 = ensureEventsMap();
    if(!m0) return;
    setTimeout(() => {
      const m = ensureEventsMap();
      if(!m) return;
      refreshEventsMapSize();
      const pts = Object.keys(this.byId).map(id => this.byId[id].getLatLng());
      if(pts.length) m.fitBounds(L.latLngBounds(pts).pad(0.2), { animate: false });
      else toast('No natural events have coordinates in the current selection');
      $('events-map').scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 320);
  },
  buildChart(){
    // the chart mirrors the current selection so it can never disagree with the map
    const tally = {};
    this.visibleEvents().forEach(ev => { const id = this.catId(ev); tally[id] = (tally[id] || 0) + 1; });
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if(!entries.length) return;
    const t = Charts.theme();
    Charts.make('chart-eonet', {
      type: 'bar',
      data: {
        labels: entries.map(e => this.cat(e[0]).l),
        datasets: [{ label: 'open events', data: entries.map(e => e[1]), backgroundColor: entries.map(e => this.cat(e[0]).c), borderRadius: 5 }]
      },
      options: {
        indexAxis: 'y',
        scales: { x: { grid: { color: t.grid }, ticks: { precision: 0 }, beginAtZero: true }, y: { grid: { display: false } } },
        plugins: { legend: { display: false } }
      }
    });
  }
};

/* built-in sample events, shown only while the live feeds are throttled or unreachable */
Object.assign(SampleData, {
  donki(){
    const now = Date.now(), D = 86400000;
    const at = (daysAgo, hour) => new Date(now - daysAgo * D).toISOString().slice(0, 10) + 'T' + String(hour).padStart(2, '0') + ':00Z';
    return {
      FLR: [
        { flrID: 'sample-flr-1', beginTime: at(1, 4),  peakTime: at(1, 4),  endTime: at(1, 5),  classType: 'M1.4', sourceLocation: 'N14E32', activeRegionNum: 3784 },
        { flrID: 'sample-flr-2', beginTime: at(3, 17), peakTime: at(3, 18), endTime: at(3, 18), classType: 'C6.2', sourceLocation: 'S08W11', activeRegionNum: 3781 },
        { flrID: 'sample-flr-3', beginTime: at(6, 9),  peakTime: at(6, 9),  endTime: at(6, 10), classType: 'X1.1', sourceLocation: 'N22E58', activeRegionNum: 3779 },
        { flrID: 'sample-flr-4', beginTime: at(11, 22), peakTime: at(11, 23), endTime: at(11, 23), classType: 'C2.7', sourceLocation: 'N11E03', activeRegionNum: 3776 },
        { flrID: 'sample-flr-5', beginTime: at(17, 6), peakTime: at(17, 6), endTime: at(17, 7), classType: 'M3.8', sourceLocation: 'S16E44', activeRegionNum: 3772 },
        { flrID: 'sample-flr-6', beginTime: at(23, 14), peakTime: at(23, 15), endTime: at(23, 15), classType: 'B9.1', sourceLocation: 'N05W22', activeRegionNum: 3769 }
      ],
      GST: [
        { gstID: 'sample-gst-1', startTime: at(3, 19), allKpIndex: [{ observedTime: at(3, 18), kpIndex: 5 }, { observedTime: at(3, 21), kpIndex: 6 }, { observedTime: at(4, 0), kpIndex: 5 }] },
        { gstID: 'sample-gst-2', startTime: at(16, 2), allKpIndex: [{ observedTime: at(16, 3), kpIndex: 5 }] }
      ],
      CME: [
        { activityID: 'sample-cme-1', startTime: at(3, 13), sourceLocation: 'N17W20', cmeAnalyses: [{ type: 'S', speed: 612, isMostAccurate: true }] },
        { activityID: 'sample-cme-2', startTime: at(6, 7),  sourceLocation: 'N22E60', cmeAnalyses: [{ type: 'C', speed: 1044, isMostAccurate: true }] },
        { activityID: 'sample-cme-3', startTime: at(16, 23), sourceLocation: 'N12W05', cmeAnalyses: [{ type: 'S', speed: 388, isMostAccurate: true }] }
      ]
    };
  },
  eonet(){
    const now = Date.now(), D = 86400000;
    const mk = (key, title, cat, catLabel, days, lat, lon, mag, unit, src, srcUrl) => ({
      id: 'SAMPLE_' + key, title: title,
      categories: [{ id: cat, title: catLabel }],
      sources: [{ id: src, url: srcUrl }],
      geometry: [{ magnitudeValue: mag, magnitudeUnit: unit, date: new Date(now - days * D).toISOString(), type: 'Point', coordinates: [lon, lat] }]
    });
    return [
      mk('wf-ca',   'Creek Fire, California',        'wildfires',    'Wildfires',            2,  38.92, -119.84, 12800, 'acres', 'InciWeb',  'https://inciweb.wildfire.gov/'),
      mk('wf-br',   'Pantanal wetland fires',        'wildfires',    'Wildfires',            4, -17.53,  -56.84, 42000, 'acres', 'INPE',     'https://terrabrasilis.dpi.inpe.br/'),
      mk('wf-za',   'Free State grassland fires',    'wildfires',    'Wildfires',            9, -28.45,   26.10,  6100, 'acres', 'SANParks', 'https://www.sanparks.org/'),
      mk('st-wp',   'Typhoon Kalmaegi',              'severeStorms', 'Severe storms',        1,  17.20,  132.40,   105, 'kts',   'JTWC',     'https://www.metoc.navy.mil/jtwc/'),
      mk('st-ep',   'Hurricane Fernanda',            'severeStorms', 'Severe storms',        3,  16.40, -117.30,    95, 'kts',   'NOAA_NHC','https://www.nhc.noaa.gov/'),
      mk('st-in',   'Cyclone Ashwin, Bay of Bengal', 'severeStorms', 'Severe storms',        6,  16.80,   87.10,    60, 'kts',   'JTWC',     'https://www.metoc.navy.mil/jtwc/'),
      mk('vc-is',   'Fagradalsfjall eruption',       'volcanoes',    'Volcanoes',           12,  63.89,  -22.27,   null, '',     'IMO',      'https://en.vedur.is/'),
      mk('vc-it',   'Mount Etna paroxysm',           'volcanoes',    'Volcanoes',            7,  37.75,   14.99,   null, '',     'INGV',     'https://www.ct.ingv.it/'),
      mk('ic-aa',   'Iceberg A-84 breaks free',      'icebergs',     'Icebergs',            18, -66.50,   55.00,   null, '',     'NSIDC',    'https://nsidc.org/'),
      mk('ic-gl',   'Great Lakes ice cover',         'seaLakeIce',   'Sea & lake ice',      14,  44.50,  -84.50,   18.2, '%',    'NOAA_GLERL','https://www.glerl.noaa.gov/'),
      mk('dr-ho',   'Horn of Africa drought',        'drought',      'Drought',             28,   8.50,   44.00,   null, '',     'FEWS_NET', 'https://fews.net/'),
      mk('du-at',   'Saharan dust over the Atlantic','dustHaze',     'Dust & haze',          5,  15.00,  -35.00,   null, '',     'NOAA',     'https://www.noaa.gov/'),
      mk('sn-pa',   'Patagonia snowpack',            'snow',         'Snow',                21, -45.00,  -71.00,   null, '',     'NASA',     'https://earthdata.nasa.gov/'),
      mk('fl-pk',   'Indus river flooding, Pakistan', 'floods',      'Floods',               3,  27.70,   68.85,   null, '',     'Dartmouth_Flood_Observatory', 'https://floodobservatory.colorado.edu/'),
      mk('fl-ng',   'Niger river floods',             'floods',      'Floods',              11,   9.06,    7.49,   null, '',     'GDACS',    'https://www.gdacs.org/'),
      mk('wc-er',   'Lake Erie algal bloom',         'waterColor',   'Water colour',        10,  41.80,  -81.50,   null, '',     'NOAA',     'https://www.noaa.gov/')
    ];
  }
});

/* ================================================================
   NOAA SWPC — the real-time side of space weather
   ================================================================ */
const Swpc = {
  BASE: 'https://services.swpc.noaa.gov/',
  /* Every one of these is a small, key-less SWPC product; the big OVATION grid the aurora
     overlay uses is fetched lazily elsewhere, so this card stays cheap to open. */
  FEEDS: {
    kp: 'products/noaa-planetary-k-index.json',
    kpFc: 'products/noaa-planetary-k-index-forecast.json',
    wind: 'products/summary/solar-wind-speed.json',
    mag: 'products/summary/solar-wind-mag-field.json',
    flux: 'products/summary/10cm-flux.json',
    xray: 'json/goes/primary/xray-flares-latest.json'
  },
  TTL: 10 * 60 * 1000,
  data: {}, at: null, isCached: false, busy: false, why: '', missing: [],
  gScale(kp){
    const k = num(kp);
    if(k == null || k < 5) return { l: 'quiet', cls: '', g: '' };
    if(k < 6) return { l: 'minor storm', cls: 'g3', g: 'G1' };
    if(k < 7) return { l: 'moderate storm', cls: 'g3', g: 'G2' };
    if(k < 8) return { l: 'strong storm', cls: 'g4', g: 'G3' };
    if(k < 9) return { l: 'severe storm', cls: 'g4', g: 'G4' };
    return { l: 'extreme storm', cls: 'g5', g: 'G5' };
  },
  async load(force){
    if(this.busy) return;
    this.busy = true;
    const meta = $('swpc-meta');
    if(meta) meta.textContent = 'querying NOAA SWPC…';
    this.missing = [];
    const hit = ApiCache.get('swpc');
    if(!force && hit && hit.data && hit.age < this.TTL){
      this.data = hit.data; this.isCached = false; this.at = hit.at;
      this.busy = false;
      this.render();
      this.refreshInBackground();
      return;
    }
    await this.fetchAll();
    this.busy = false;
    this.render();
  },
  /* A partial answer is still an answer: SWPC's products are independent endpoints, so one
     being down must not blank the other four — each is settled on its own. */
  async fetchAll(){
    const keys = Object.keys(this.FEEDS);
    const out = {};
    const results = await Promise.all(keys.map(k =>
      httpJSON(this.BASE + this.FEEDS[k], { timeoutMs: 15000 })
        .then(d => ({ k: k, d: d }))
        .catch(e => ({ k: k, e: e }))));
    let got = 0, err = null;
    results.forEach(r => {
      if(r.d){ out[r.k] = r.d; got++; }
      else { this.missing.push(r.k); if(!err) err = r.e; }
    });
    if(got){
      this.data = out;
      this.at = Date.now();
      this.isCached = false;
      this.why = this.missing.length ? 'Some SWPC products did not answer' : '';
      ApiCache.set('swpc', out);
      return true;
    }
    this.why = err && err.timedOut ? 'NOAA SWPC did not answer in time' : 'NOAA SWPC could not be reached';
    const cached = ApiCache.get('swpc');
    if(cached && cached.data){ this.data = cached.data; this.at = cached.at; this.isCached = true; }
    else { this.data = this.sample(); this.isCached = false; this.isSample = true; }
    return false;
  },
  refreshInBackground(){
    if(this._bg) return;
    this._bg = setTimeout(() => { this._bg = null; this.fetchAll().then(() => this.render()); }, 4000);
  },
  sample(){
    const now = Date.now();
    const kp = [];
    for(let i = 23; i >= 0; i--) kp.push({ time_tag: new Date(now - i * 3 * 3600000).toISOString().slice(0, 19), Kp: (i % 5 === 0 ? 4.33 : 2.67), a_running: 12, station_count: 8 });
    return {
      kp: kp,
      kpFc: kp.map(r => ({ time_tag: r.time_tag, kp: r.Kp, observed: 'observed', noaa_scale: null })),
      wind: [{ proton_speed: 412, time_tag: new Date(now - 600000).toISOString() }],
      mag: [{ bt: 6, bz_gsm: -3, time_tag: new Date(now - 600000).toISOString() }],
      flux: [{ flux: 132, time_tag: new Date(now - 3600000).toISOString() }],
      xray: [{ current_class: 'C2.4', max_class: 'C5.1', begin_time: new Date(now - 7200000).toISOString(), max_time: new Date(now - 5400000).toISOString(), satellite: 18 }]
    };
  },
  lastOf(arr){ const a = Array.isArray(arr) ? arr : []; return a.length ? a[a.length - 1] : null; },
  render(){
    const d = this.data || {};
    const kpArr = Array.isArray(d.kp) ? d.kp : [];
    const lastKp = this.lastOf(kpArr.map(r => ({ t: r.time_tag, kp: num(r.Kp) })));
    const gs = this.gScale(lastKp && lastKp.kp);
    const wind = this.lastOf(d.wind);
    const mag = this.lastOf(d.mag);
    const flux = this.lastOf(d.flux);
    const xray = this.lastOf(Array.isArray(d.xray) ? d.xray : []);
    const kp = lastKp && lastKp.kp != null ? lastKp.kp : null;
    $('swpc-kp').innerHTML = kp != null ? fmt(kp, 2) : '—';
    $('swpc-kp-sub').textContent = kp != null
      ? `${gs.g ? gs.g + ' · ' + gs.l : gs.l} · ${utcStamp(new Date(lastKp.t + 'Z')).slice(11, 16)} UTC`
      : 'no Kp reading';
    const kpBox = $('swpc-kp-box');
    if(kpBox) kpBox.className = 'swpc-kv ' + gs.cls;
    const speed = wind ? num(wind.proton_speed) : null;
    $('swpc-wind').innerHTML = speed != null ? fmt(speed, 0) + '<span class="u">km/s</span>' : '—';
    $('swpc-wind-sub').textContent = speed != null
      ? (speed < 300 ? 'slow stream' : speed < 500 ? 'nominal' : speed < 700 ? 'fast stream' : 'very fast — storm driver') + ' · ' + utcStamp(new Date(wind.time_tag)).slice(11, 16) + ' UTC'
      : 'not reported';
    const bz = mag ? num(mag.bz_gsm) : null, bt = mag ? num(mag.bt) : null;
    $('swpc-bz').innerHTML = bz != null ? fmt(bz, 1) + '<span class="u">nT</span>' : '—';
    $('swpc-bz-sub').textContent = bz != null
      ? (bz <= -10 ? 'strongly southward — couples well with the magnetosphere' : bz < 0 ? 'southward — geomagnetic activity likely' : 'northward — quiet') + (bt != null ? ' · Bt ' + fmt(bt, 0) + ' nT' : '')
      : 'not reported';
    const f107 = flux ? num(flux.flux) : null;
    $('swpc-flux').innerHTML = f107 != null ? fmt(f107, 0) + '<span class="u">sfu</span>' : '—';
    $('swpc-flux-sub').textContent = f107 != null
      ? (f107 < 100 ? 'low solar radio output' : f107 < 150 ? 'moderate — active regions present' : 'elevated — flare-favourable') + ' · ' + utcStamp(new Date(flux.time_tag)).slice(11, 16) + ' UTC'
      : 'not reported';
    const cls = xray ? String(xray.current_class || '—') : '—';
    $('swpc-xray').textContent = cls;
    $('swpc-xray-sub').textContent = xray
      ? `latest peak ${xray.max_class || '—'} · ${xray.max_time ? utcStamp(new Date(xray.max_time)).slice(11, 16) + ' UTC' : ''}`.trim()
      : 'no flare record';
    const stamp = this.at ? utcStamp(new Date(this.at)) : '—';
    const meta = $('swpc-meta');
    if(meta) meta.innerHTML = 'NOAA SWPC · updated ' + esc(stamp.slice(11, 16)) + ' UTC'
      + (this.isCached ? SampleData.badge('cached') : (this.isSample ? SampleData.badge('sample') : ''));
    const n = $('swpc-notice');
    if(n){
      if(this.why || this.isSample || this.isCached){
        n.innerHTML = `<div class="notice ${this.isSample || this.isCached ? 'bad' : ''}"><span class="n-ico">📡</span><div>`
          + `<b>${esc(this.why || 'The live SWPC products are unavailable')}${this.isCached ? ' — showing the last good reading' : ''}${this.isSample && !this.isCached ? ' — showing a sample reading' : ''}.</b>`
          + (this.missing.length ? ` Missing right now: <b>${esc(this.missing.join(', '))}</b>.` : '')
          + `<span class="n-sub">Every SWPC product is key-less and independent, so whichever ones did answer above are live. Nothing here needs an api.nasa.gov key.</span>`
          + `<div class="n-actions">${Retry.btn('swpc', '↻ retry all six products')}</div></div></div>`;
        n.hidden = false;
      } else { n.hidden = true; n.innerHTML = ''; }
      Retry.register('swpc', () => this.load(true));
    }
    this.forecastList();
    this.chart();
    if($('swpc-note')){
      $('swpc-note').innerHTML = 'Kp is the planetary geomagnetic index: 0–4 is quiet, 5 a minor storm (G1), 7+ a strong one (G3+), and 5+ is typically when aurora becomes visible from the mid-latitudes. Wind, Bz and F10.7 are the drivers: a strongly negative Bz with a fast stream is what carries a geomagnetic storm in.';
    }
    Timeline.bump();
  },
  forecastList(){
    const host = $('kp-forecast');
    if(!host) return;
    const rows = Array.isArray(this.data && this.data.kpFc) ? this.data.kpFc : [];
    const pred = rows.filter(r => String(r.observed || '').toLowerCase().indexOf('predict') === 0 || String(r.observed || '').toLowerCase() === 'predicted');
    const now = Date.now();
    const next = pred.filter(r => new Date(String(r.time_tag) + 'Z').getTime() >= now - 10800000).slice(0, 9);
    if(!next.length){
      host.innerHTML = '<div class="empty">No 3-day Kp forecast was returned — NOAA usually files one every few hours.</div>';
      return;
    }
    host.innerHTML = next.map(r => {
      const kp = num(r.kp);
      const gs = this.gScale(kp);
      const when = utcStamp(new Date(String(r.time_tag) + 'Z'));
      const pct = kp == null ? 0 : Math.max(3, Math.min(100, (kp / 9) * 100));
      const cls = kp != null && kp >= 6 ? 'storm' : (kp != null && kp >= 5 ? 'notable' : '');
      return `<div class="kp-row"><span class="w">${esc(when.slice(5, 16))}</span>`
        + `<span class="v">${kp != null ? fmt(kp, 2) : '—'}${gs.g ? ' <span class="lbl">' + gs.g + '</span>' : ''}</span>`
        + `<span class="kp-bar"><i class="${cls}" style="width:${pct}%"></i></span></div>`;
    }).join('');
    this.predicted = next.map(r => ({ t: new Date(String(r.time_tag) + 'Z').getTime(), kp: num(r.kp) })).filter(r => r.kp != null);
  },
  /* One series, not two. Charts.make deliberately drops any index where a dataset is blank
     (labels and every series are filtered *together*), so splitting observed and forecast into
     two datasets would delete every point where either is null and leave an empty chart. The
     forecast is drawn instead as a segment of the same line — dashed and amber from the model
     boundary onward — and the G1 threshold is a second, constant line so the eye has a scale. */
  chart(){
    const fc = Array.isArray(this.data && this.data.kpFc) ? this.data.kpFc : [];
    const now = Date.now();
    const rows = fc.filter(r => {
      const t = new Date(String(r.time_tag) + 'Z').getTime();
      return isFinite(t) && t >= now - 48 * 3600000 && t <= now + 72 * 3600000;
    });
    const th = Charts.theme();
    if(!rows.length){
      const kpArr = Array.isArray(this.data && this.data.kp) ? this.data.kp : [];
      const tail = kpArr.slice(-16);
      if(!tail.length) return;
      Charts.make('chart-kp', {
        type: 'bar',
        data: {
          labels: tail.map(r => String(r.time_tag).slice(5, 16).replace('T', ' ')),
          datasets: [
            { label: 'Kp · observed', data: tail.map(r => num(r.Kp)), backgroundColor: th.accent, borderRadius: 3 },
            this.threshold(th, tail.length)
          ]
        },
        options: this.chartOpts()
      });
      return;
    }
    const labels = rows.map(r => String(r.time_tag).slice(5, 16).replace('T', ' '));
    const vals = rows.map(r => num(r.kp));
    let cut = rows.findIndex(r => String(r.observed || '').toLowerCase().indexOf('predict') === 0);
    if(cut < 0) cut = rows.length;
    const colors = rows.map((_r, i) => (i >= cut ? th.warm : th.accent));
    Charts.make('chart-kp', {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Kp · observed, then forecast',
            data: vals,
            borderColor: th.accent,
            backgroundColor: colors,
            pointBackgroundColor: colors,
            pointRadius: 2,
            tension: .3,
            fill: false,
            segment: {
              borderColor: ctx => (ctx.p1DataIndex >= cut ? th.warm : th.accent),
              borderDash: ctx => (ctx.p1DataIndex >= cut ? [5, 4] : undefined)
            }
          },
          this.threshold(th, labels.length)
        ]
      },
      options: this.chartOpts()
    });
  },
  threshold(t, n){
    return {
      label: 'G1 storm threshold · Kp 5',
      data: new Array(Math.max(1, n)).fill(5),
      borderColor: t.hot, borderDash: [2, 3], borderWidth: 1,
      pointRadius: 0, fill: false, tension: 0
    };
  },
  chartOpts(){
    return {
      plugins: { legend: { display: true, labels: { boxWidth: 10, boxHeight: 10 } } },
      scales: {
        y: { beginAtZero: true, suggestedMax: 9, title: { display: true, text: 'Kp index' }, grid: { color: Charts.theme().grid } },
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } }
      }
    };
  }
};

export { Donki, Eonet, Swpc };

export function loadDonkiPublic(){ return Donki.load(); }
export function loadEonetPublic(){ return Eonet.load(); }
export function loadSwpcPublic(force){ return Swpc.load(force); }
