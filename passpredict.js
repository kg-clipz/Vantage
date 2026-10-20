import { toast } from '../ui.js';
/* ================================================================
   Vantage — js/modules/passpredict.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */
import { $, Store, httpJSON, esc, fmt, num, isoDate, ApiCache, Retry, SampleData } from '../api.js';
/* ================================================================
   ISS pass predictor — when the station next rides over *you*

   How a pass is computed (the same three inputs the UI tooltip describes):

    1. TLE propagation. The station's position over time comes from live
       Celestrak two-line element sets, propagated with Skyfield's SGP4
       implementation upstream. Nothing in this page maintains an orbit
       model, so the prediction cannot silently drift as the station
       reboosts — it always tracks current elements, and no API key is
       burned to get them.

    2. Observer latitude & longitude. A pass exists when the station
       rises above the observer's local horizon (the service uses a 10°
       floor), peaks at its maximum elevation, then sets. The observer
       point is the only input this page supplies, which is why the
       location is cached — see LOC_KEY — and reused for every request.

    3. Solar illumination. Whether a pass is *visible* is decided by
       comparing the sun angle at the station with the sun angle at the
       observer: the station must be sunlit while the observer's sky is
       dark. That is why a high noon pass is correctly a daylight pass
       and is filtered out by `visible_only=true`, not shown as visible.

   Results are cached per rounded location (TTL below), because a pass list is good for half
   an hour and this is a small free service that should not be hit on every keystroke. The
   `?` button in the card head renders the same explanation for the viewer.
   ================================================================ */
const PassPredict = {
  BASE: 'https://sat.terrestre.ar/passes/25544',
  TTL: 30 * 60 * 1000,
  LOC_KEY: 'vantage-pass-loc',
  data: [], visibleOnly: false, busy: false, queued: false, at: null, isCached: false, lastErr: '',
  init(){
    const saved = Store.getJSON(this.LOC_KEY, null);
    if(saved && this.valid(num(saved.lat), num(saved.lon))){
      /* the observer defaults to NASA Headquarters now, so a saved location that is exactly
         the previous built-in default is stale default carryover, not a place the viewer
         chose — it migrates to the new default. Anything else was a deliberate change and
         is kept, which is the whole "unless people change it" rule. */
      const isOldDefault = Math.abs(num(saved.lat) - 51.5074) < 0.0002
        && Math.abs(num(saved.lon) - (-0.1278)) < 0.0002;
      if(!isOldDefault){
        $('pass-lat').value = String(saved.lat);
        $('pass-lon').value = String(saved.lon);
      }
    }
    this.visibleOnly = Store.get('vantage-pass-visible', '0') === '1';
    Retry.register('passes', () => this.run(true));
    this.paintVisible();
    this.run(false);   // predict immediately for the on-screen location — never an empty card
  },
  lat(){ return num($('pass-lat').value); },
  lon(){ return num($('pass-lon').value); },
  valid(lat, lon){ return lat != null && lon != null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180; },
  key(lat, lon){ return 'pass:' + lat.toFixed(1) + ':' + lon.toFixed(1) + ':' + (this.visibleOnly ? 'vis' : 'all'); },
  url(lat, lon){
    return this.BASE + '?lat=' + lat.toFixed(4) + '&lon=' + lon.toFixed(4)
      + '&limit=8&days=10' + (this.visibleOnly ? '&visible_only=true' : '');
  },
  rel(ts){
    const ms = ts * 1000 - Date.now();
    if(ms <= 0) return 'in progress';
    const m = Math.round(ms / 60000);
    if(m < 60) return 'in ' + m + ' min';
    const h = Math.floor(m / 60);
    return 'in ' + h + 'h ' + (m % 60) + 'm';
  },
  row(p){
    const rise = p.rise || {}, culm = p.culmination || {}, set = p.set || {};
    const ts = num(rise.utc_timestamp) || num(culm.utc_timestamp);
    if(ts == null) return '';
    const iso = new Date(ts * 1000).toISOString();
    const dur = Math.round(((num(set.utc_timestamp) || ts) - ts) / 60);
    const vis = !!(rise.visible || culm.visible);
    const maxAlt = num(culm.alt);
    return `<div class="pass-row">
        <div class="p-when">${esc(iso.slice(5, 10))}<br>${esc(iso.slice(11, 16))} UTC</div>
        <div>
          <div class="p-title">${esc(this.rel(ts))} · rises ${esc(rise.az_octant || '—')}, sets ${esc(set.az_octant || '—')}</div>
          <div class="p-sub">peaks ${esc(culm.az_octant || '—')} · above a 10° horizon for about ${dur} min</div>
        </div>
        <div class="p-max">${maxAlt != null ? fmt(maxAlt, 0) : '—'}<span>° max elevation</span></div>
        <div class="p-visible ${vis ? 'yes' : 'no'}">${vis ? 'visible' : 'daylight pass'}</div>
      </div>`;
  },
  render(){
    const host = $('pass-list');
    if(!host) return;
    if(!this.data.length){
      const fallback = this.visibleOnly
        ? 'No <b>visible</b> passes over this location in the next 10 days — switch “visible only” off to see every pass.'
        : 'No passes returned for this location in the next 10 days.';
      host.innerHTML = `<div class="empty">${esc(this.lastErr) || fallback} ${Retry.btn('passes', '↻ retry')}</div>`;
      return;
    }
    const rows = this.data.map(p => this.row(p)).filter(Boolean);
    host.innerHTML = rows.length ? rows.join('')
      : `<div class="empty">The service returned passes without usable timestamps. ${Retry.btn('passes', '↻ retry')}</div>`;
  },
  paintVisible(){
    const b = $('pass-visible');
    if(!b) return;
    b.textContent = 'visible only: ' + (this.visibleOnly ? 'on' : 'off');
    b.classList.toggle('on', this.visibleOnly);
    b.setAttribute('aria-pressed', String(this.visibleOnly));
  },
  paintMeta(){
    const meta = $('pass-meta'), note = $('pass-note');
    if(meta){
      meta.innerHTML = this.data.length
        ? `${this.data.length} pass${this.data.length === 1 ? '' : 'es'} · ${this.lat().toFixed(2)}°, ${this.lon().toFixed(2)}°${this.isCached ? SampleData.badge('cached') : ''}`
        : `pass prediction · ${this.lat() != null ? this.lat().toFixed(2) + '°, ' + this.lon().toFixed(2) + '°' : 'no location set'}`;
    }
    if(note){
      note.textContent = this.lastErr && this.data.length
        ? this.lastErr.replace(/\.$/, '') + ' — showing the previous result'
        : this.isCached && this.at
          ? 'cached result from ' + new Date(this.at).toISOString().slice(11, 16) + ' UTC'
          : (this.data.length ? 'live from the passes service · times in UTC' : 'ready — press predict');
    }
  },
  async run(force){
    /* A request that arrives mid-fetch used to be dropped, which quietly left the list showing
       the *previous* location — easy to hit now that the jellyfish panel can move the observer
       too. Queue it instead, and let the fetch in flight finish. */
    if(this.busy){ this.queued = true; return; }
    const lat = this.lat(), lon = this.lon();
    if(!this.valid(lat, lon)){
      this.data = []; this.lastErr = 'Enter a latitude between -90 and 90 and a longitude between -180 and 180.';
      this.render(); return;
    }
    const key = this.key(lat, lon);
    const hit = ApiCache.get(key);
    if(!force && hit && hit.age < this.TTL){
      this.data = Array.isArray(hit.data) ? hit.data : [];
      this.isCached = true; this.at = hit.at; this.lastErr = '';
      this.paintMeta(); this.render(); return;
    }
    this.busy = true;
    if($('pass-note')) $('pass-note').textContent = 'computing passes…';
    try{
      const d = await httpJSON(this.url(lat, lon), { timeoutMs: 25000 });
      this.data = Array.isArray(d) ? d : [];
      ApiCache.set(key, this.data);
      this.isCached = false; this.at = Date.now(); this.lastErr = '';
      Store.setJSON(this.LOC_KEY, { lat: lat, lon: lon });
    }catch(e){
      const stale = ApiCache.get(key);
      const kept = !!(stale && Array.isArray(stale.data) && stale.data.length) ? stale.data
        : (this.data.length ? this.data : null);
      if(kept){
        /* a small public instance answers 500 under load. A failed *refresh* must never wipe
           a list the viewer is reading, so the previous result is kept and flagged. */
        this.data = kept;
        this.isCached = true;
        this.at = (stale && stale.at) || this.at;
      } else {
        this.data = []; this.isCached = false;
      }
      this.lastErr = (e && e.timedOut) ? 'The passes service did not answer in time.'
        : (e && e.rateLimited) ? 'The passes service is busy — it throttles bursts.'
        : 'The passes service could not be reached.';
    }
    this.busy = false;
    this.paintMeta();
    this.render();
    if(this.queued){ this.queued = false; this.run(force); }   // a location moved while we were fetching
  },
  async geo(){
    if(!navigator.geolocation){ toast('This browser has no location API — type a latitude and longitude instead'); return; }
    if($('pass-note')) $('pass-note').textContent = 'asking the browser for your location…';
    try{
      const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 12000, maximumAge: 600000 }));
      $('pass-lat').value = pos.coords.latitude.toFixed(4);
      $('pass-lon').value = pos.coords.longitude.toFixed(4);
      toast('Location set from this device');
      this.run(true);
    }catch(e){
      const why = e && e.code === 1 ? 'Location permission was refused'
        : e && e.code === 3 ? 'The location request timed out' : 'Your location is unavailable';
      if($('pass-note')) $('pass-note').textContent = why + ' — type a latitude and longitude instead';
      toast(why + ' — enter coordinates manually');
    }
  },
  toggleVisible(){
    this.visibleOnly = !this.visibleOnly;
    Store.set('vantage-pass-visible', this.visibleOnly ? '1' : '0');
    this.paintVisible();
    this.run(true);
  },
  /* the `?` affordance: same three inputs as the comment block above, written for the
     viewer. Dismissed by a second click, Escape, or a click anywhere outside it. */
  toggleHelp(){
    const btn = $('pass-help'), pop = $('pass-help-pop');
    if(!btn || !pop) return;
    const open = pop.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
    return open;
  },
  closeHelp(){
    const btn = $('pass-help'), pop = $('pass-help-pop');
    if(!pop || !pop.classList.contains('open')) return false;
    pop.classList.remove('open');
    if(btn) btn.setAttribute('aria-expanded', 'false');
    return true;
  }
};

export { PassPredict };
