import { toast, showView } from '../ui.js';
/* ================================================================
   Vantage — js/modules/aurora.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */

import { $, Store, httpJSON, esc, fmt, num, isoDate } from '../api.js';
/* ================================================================
   Aurora forecast — NOAA SWPC OVATION, drawn as a map overlay
   The product is a 1°×1° probability grid in geographic coordinates,
   so it is rasterised to a canvas here and handed to Leaflet as an
   equirectangular image overlay. That keeps the geometry honest: a
   pre-rendered polar-projection chart would land the oval in the
   wrong place the moment it is stretched over a Mercator map.
   ================================================================ */
const Aurora = {
  GET: 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
  ON_KEY: 'vantage-aurora-on',
  W: 360, H: 181,
  on: false, grid: null, meta: null, layer: null, url: null, busy: false, max: 0,
  async toggle(){
    if(this.on){ this.hide(); return; }
    if(this.busy) return;
    if(!this.grid){
      this.busy = true;
      this.paint('loading NOAA aurora forecast…');
      try{
        const d = await httpJSON(this.GET, { timeoutMs: 25000 });
        this.grid = d && Array.isArray(d.coordinates) ? d.coordinates : null;
        this.meta = d || null;
      }catch(e){
        this.grid = null;
        this.err = e && e.timedOut ? 'NOAA did not answer in time.' : 'NOAA SWPC could not be reached.';
      }
      this.busy = false;
      if(!this.grid){
        this.paint();
        toast(this.err || 'The aurora forecast could not be loaded — try again shortly');
        return;
      }
    }
    this.on = true;
    Store.set(this.ON_KEY, '1');
    this.attach();
    this.paint();
    toast('Aurora forecast overlay on — NOAA OVATION, 30-minute product');
  },
  hide(){
    this.on = false;
    Store.set(this.ON_KEY, '0');
    const m = ensureEventsMap();
    if(m && this.layer && m.hasLayer(this.layer)) m.removeLayer(this.layer);
    this.paint();
  },
  /* rasterise the probability grid; x is shifted by half a frame because the product counts
     longitude 0…359°E while the overlay spans -180…180° */
  raster(){
    if(this.url) return this.url;
    if(!this.grid) return null;
    const cv = document.createElement('canvas');
    cv.width = this.W; cv.height = this.H;
    const ctx = cv.getContext('2d');
    if(!ctx) return null;
    const img = ctx.createImageData(this.W, this.H);
    const d = img.data;
    let max = 0;
    for(let n = 0; n < this.grid.length; n++){
      const p = this.grid[n];
      if(!p || p.length < 3) continue;
      const lon = num(p[0]), lat = num(p[1]), v = num(p[2]);
      if(lon == null || lat == null || v == null) continue;
      const x = ((Math.round(lon) + 180) % 360 + 360) % 360;
      const y = Math.round(90 - lat);
      if(y < 0 || y >= this.H) continue;
      if(v > max) max = v;
      if(v <= 0) continue;
      const a = Math.max(0, Math.min(1, v / 100));
      const i = (y * this.W + x) * 4;
      d[i]     = Math.round(70 + 185 * a * a);      // green at low odds, red as it approaches certain
      d[i + 1] = Math.round(232 - 70 * a);
      d[i + 2] = Math.round(120 - 110 * a);
      d[i + 3] = Math.round(a * 235);
    }
    ctx.putImageData(img, 0, 0);
    this.max = max;
    this.url = cv.toDataURL('image/png');
    return this.url;
  },
  attach(){
    if(!this.on) return false;
    const m = ensureEventsMap();
    if(typeof L === 'undefined' || !m) return false;   // built lazily on first events view
    const url = this.raster();
    if(!url) return false;
    if(!this.layer){
      this.layer = L.imageOverlay(url, [[-90, -180], [90, 180]], {
        opacity: 0.68, interactive: false, attribution: 'Aurora forecast: NOAA SWPC OVATION'
      });
    }
    if(!m.hasLayer(this.layer)) this.layer.addTo(m);
    this.paint();   // the note may have painted before the raster existed — keep them in step
    return true;
  },
  /* A remembered "on" is restored silently — no toast, and no forced events-map build at
     boot. The overlay only needs a canvas, and attach() takes care of itself from
     showView('events'), which is where a measurable container finally exists. */
  async arm(){
    if(Store.get(this.ON_KEY, '0') !== '1'){ this.paint(); return; }
    this.on = true;
    this.paint('restoring the aurora overlay you left switched on…');
    try{
      const d = await httpJSON(this.GET, { timeoutMs: 25000 });
      this.grid = d && Array.isArray(d.coordinates) ? d.coordinates : null;
      this.meta = d || null;
    }catch(e){ this.grid = null; }
    if(!this.grid){
      this.on = false; Store.set(this.ON_KEY, '0');
      this.paint();
      toast('The NOAA aurora forecast could not be restored — the toggle is off');
      return;
    }
    this.attach();
    this.paint();
  },
  /* the chip is the control; the note line carries the provenance so a coloured band over
     the map is never mistaken for measured activity */
  paint(msg){
    const chip = $('aurora-toggle'), note = $('aurora-note');
    if(chip){
      chip.setAttribute('aria-pressed', String(this.on));
      chip.classList.toggle('aurora-on', this.on);
      chip.disabled = !!this.busy;
    }
    if(!note) return;
    if(msg){ note.hidden = false; note.textContent = msg; return; }
    if(!this.on){
      note.hidden = true; note.textContent = ''; return;
    }
    const obs = this.meta && this.meta['Observation Time'] ? String(this.meta['Observation Time']).slice(11, 16) : null;
    const fc = this.meta && this.meta['Forecast Time'] ? String(this.meta['Forecast Time']).slice(11, 16) : null;
    /* the raster is only built when a measurable map exists, which can be a view-switch later
       than the first paint — so the peak is read from the grid, never from the last raster */
    const peak = this.grid ? this.grid.reduce((m, p) => { const v = num(p && p[2]); return v != null && v > m ? v : m; }, 0) : 0;
    note.hidden = false;
    note.innerHTML = `Aurora overlay on · NOAA SWPC OVATION 30-minute forecast`
      + (obs ? ` · observed <span class="aurora-kp">${esc(obs)} UTC</span>` : '')
      + (fc ? `, valid to <span class="aurora-kp">${esc(fc)} UTC</span>` : '')
      + ` · strongest probability on the grid <span class="aurora-kp">${fmt(peak, 0)}%</span>.`
      + ` The band is a forecast of where aurora is *possible*, not an observation — and it is drawn at 1° resolution, so its edges are blockier than the maps beneath it.`
      + ` <button class="retry-btn" data-aurora-frame>⤢ frame the aurora</button>`;
  },
  /* the oval lives above |lat| 52, so at world zoom it is a sliver along the very top and
     bottom edges of the map. This puts the hemisphere with the stronger forecast in front
     of the viewer, which is the difference between the layer being decorative and useful. */
  /* Fitting the whole hemisphere would be useless — the oval spans every longitude, so
     fitBounds settles at zoom 0 and the band is as invisible as it was before. Instead the
     arc *above 75% of that hemisphere's peak* is measured and framed, which lands on the
     active part of the oval at a zoom that can actually show it. */
  zone(hemi){
    const cells = this.grid.filter(p => p && p[2] >= 10 && Math.sign(p[1]) === hemi);
    if(!cells.length) return null;
    const max = cells.reduce((mx, p) => (p[2] > mx ? p[2] : mx), 0);
    const core = cells.filter(p => p[2] >= max * 0.75);
    if(!core.length) return null;
    const lats = core.map(p => p[1]);
    /* longitude wraps: the arc can straddle the dateline, so 0…359°E is normalised first */
    const lons = core.map(p => (p[0] > 180 ? p[0] - 360 : p[0]));
    const padLat = 9, padLon = 14;
    return {
      sum: cells.reduce((s, p) => s + p[2], 0),
      peak: max,
      bounds: [
        [Math.max(-89, Math.min.apply(null, lats) - padLat), Math.max(-180, Math.min.apply(null, lons) - padLon)],
        [Math.min(89, Math.max.apply(null, lats) + padLat), Math.min(180, Math.max.apply(null, lons) + padLon)]
      ]
    };
  },
  frame(){
    const m = ensureEventsMap();
    if(!m || !this.grid){ toast('Load the aurora forecast first'); return; }
    const n = this.zone(1), s = this.zone(-1);
    if(!n && !s){ toast('The current forecast shows no significant aurora'); return; }
    const pick = (!n) ? s : (!s) ? n : (s.sum > n.sum ? s : n);
    m.fitBounds(pick.bounds, { animate: false, maxZoom: 7 });
    setTimeout(() => { if(m.invalidateSize) m.invalidateSize(); }, 60);
    toast('Framed the ' + (pick === n ? 'northern' : 'southern') + ' oval · peak ' + pick.peak + '% probability');
  }
};

export { Aurora };
