import { Donki } from './spaceweather.js';
/* ================================================================
   Vantage — js/modules/solar.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */
import { $, Store, httpJSON, esc, fmt, num, isoDate, SampleData } from '../api.js';
/* ================================================================
   Solar flare locator
   DONKI reports each flare's origin as a heliographic string
   ("N14E32": 14° north, 32° east). Because the Sun turns about once
   every 27.3 days, each origin is rotated forward to *now* before it
   is projected onto the disk — otherwise a flare from three weeks ago
   would be drawn where the region used to be, not where it is today.
   Projection is the standard orthographic view of a sphere from
   Earth: x = −R·cos(lat)·sin(lon), y = −R·sin(lat), which puts solar
   north up and solar east on the left, as SDO and SOHO images do.
   ================================================================ */
const SolarDisk = {
  R: 200, CX: 200, CY: 200, ROT_DAYS: 27.2753, SEL: null,
  COLORS: { X: '#FF6B6B', M: '#FFB454', C: '#4F8CFF', B: '#6EE7B7', A: '#9AA5BD' },
  parse(loc){
    const m = /^([NS])(\d{1,2})([EW])(\d{1,3})$/.exec(String(loc || '').trim().toUpperCase());
    if(!m) return null;
    return { lat: (m[1] === 'N' ? 1 : -1) * Number(m[2]), lon: (m[3] === 'E' ? 1 : -1) * Number(m[4]) };
  },
  daysSince(iso){
    const t = new Date(iso).getTime();
    return isFinite(t) ? Math.max(0, (Date.now() - t) / 86400000) : 0;
  },
  toNow(loc, iso){
    const p = this.parse(loc);
    if(!p) return null;
    let lon = p.lon - (360 / this.ROT_DAYS) * this.daysSince(iso);
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    return { lat: p.lat, lon: lon };
  },
  /* Orthographic view from Earth: y = −R·sin(lat) puts north up, and x = −R·cos(lat)·sin(lon)
     puts solar EAST on the LEFT. That sign matters: the Sun turns so that features appear at
     the east limb and drift across to the west limb, which is why every standard solar image
     (SDO, SOHO) labels east on the left and west on the right. Mirroring it would silently
     put every active region on the wrong limb. */
  project(lat, lon){
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    return { x: this.CX - this.R * Math.cos(la) * Math.sin(lo), y: this.CY - this.R * Math.sin(la) };
  },
  vis(lon){ return Math.abs(lon) <= 90; },
  color(cls){ return this.COLORS[Donki.rank(cls)] || '#9AA5BD'; },
  regions(){
    const map = new Map();
    Donki.events.filter(e => e.kind === 'FLR' && e.loc).forEach(f => {
      const now = this.toNow(f.loc, f.time);
      if(!now) return;
      if(!map.has(f.loc)) map.set(f.loc, { loc: f.loc, lat: now.lat, lon: now.lon, ar: f.ar || '—', flares: [] });
      map.get(f.loc).flares.push(f);
    });
    return [...map.values()].map(r => {
      const rank = f => ((Donki.RANKS[Donki.rank(f.cls)] || 0) * 100) + Donki.size(f.cls);
      r.best = r.flares.slice().sort((a, b) => rank(b) - rank(a))[0] || null;
      r.cls = r.best ? r.best.cls : '';
      r.recent = r.flares.slice().sort((a, b) => String(b.time).localeCompare(String(a.time)))[0] || null;
      r.onDisk = this.vis(r.lon);
      return r;
    }).sort((a, b) => (b.onDisk - a.onDisk) || ((Donki.RANKS[Donki.rank(b.cls)] || 0) - (Donki.RANKS[Donki.rank(a.cls)] || 0)));
  },
  render(){
    const stage = $('sun-stage');
    if(!stage) return;
    const regs = this.regions();
    const R = this.R, CX = this.CX, CY = this.CY;
    const spots = regs.filter(r => r.onDisk).map(r => {
      const p = this.project(r.lat, r.lon);
      const c = this.color(r.cls);
      const rad = Math.min(9, 3.2 + (Donki.RANKS[Donki.rank(r.cls)] || 2) * 0.8 + Math.min(3, r.flares.length * 0.6));
      return `<g class="sun-spot${this.SEL === r.loc ? ' sel' : ''}" data-loc="${esc(r.loc)}" tabindex="0" role="button" aria-label="Active region ${esc(String(r.ar))} near ${esc(r.loc)}, ${r.flares.length} flares">`
        + `<circle class="halo" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="16" fill="${c}" opacity="0"/>`
        + `<circle class="dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rad.toFixed(1)}" fill="${c}" stroke="rgba(0,0,0,.35)" stroke-width="1"/></g>`;
    }).join('');
    const ry = deg => (R * Math.sin(deg * Math.PI / 180)).toFixed(1);
    stage.innerHTML = `<div class="sun-tip" id="sun-tip"></div>
      <svg viewBox="0 0 400 400" role="img" aria-label="Solar disk showing active flare regions">
        <defs>
          <radialGradient id="sunGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#FFF7DE"/><stop offset="58%" stop-color="#FFCB6E"/>
            <stop offset="86%" stop-color="#E88A2A"/><stop offset="100%" stop-color="#7E3B0C"/>
          </radialGradient>
          <radialGradient id="coronaGrad" cx="50%" cy="50%" r="50%">
            <stop offset="70%" stop-color="rgba(255,180,84,.26)"/><stop offset="100%" stop-color="rgba(255,180,84,0)"/>
          </radialGradient>
        </defs>
        <circle cx="${CX}" cy="${CY}" r="${R + 52}" fill="url(#coronaGrad)"/>
        <g class="sun-limb" id="sun-limb">
          <circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#sunGrad)"/>
          <ellipse cx="${CX}" cy="${CY}" rx="${R}" ry="${ry(30)}" fill="none" stroke="rgba(110,55,8,.34)" stroke-dasharray="3 4"/>
          <ellipse cx="${CX}" cy="${CY}" rx="${ry(30)}" ry="${R}" fill="none" stroke="rgba(110,55,8,.34)" stroke-dasharray="3 4"/>
          <ellipse cx="${CX}" cy="${CY}" rx="${R}" ry="${ry(60)}" fill="none" stroke="rgba(110,55,8,.20)" stroke-dasharray="3 4"/>
          <line x1="${CX}" y1="${CY - R}" x2="${CX}" y2="${CY + R}" stroke="rgba(110,55,8,.36)" stroke-dasharray="3 4"/>
          ${spots}
        </g>
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(255,180,84,.5)"/>
      </svg>`;
    this.wire();
    this.renderRegions(regs);
    const onDisk = regs.filter(r => r.onDisk).length;
    $('sun-meta').innerHTML = `${onDisk} of ${regs.length} located active region${regs.length === 1 ? '' : 's'} on the visible disk${Donki.usingSample ? SampleData.badge('sample') : ''}`;
    $('sun-note').textContent = regs.length
      ? 'hover a spot for detail · click one to magnify that region'
      : 'no located flares in this window';
    if(this.SEL) this.focus(this.SEL);   // re-apply any magnification after a re-render
  },
  renderRegions(regs){
    const host = $('sun-regions');
    if(!host) return;
    if(!regs.length){ host.innerHTML = '<div class="empty">No flares with a source location in this window.</div>'; return; }
    host.innerHTML = regs.map(r => `
      <div class="ar-row${this.SEL === r.loc ? ' sel' : ''}" data-loc="${esc(r.loc)}" tabindex="0" role="button" aria-label="Active region ${esc(String(r.ar))}">
        <span class="ar-dot" style="background:${this.color(r.cls)}"></span>
        <span class="ar-n">AR ${esc(String(r.ar))}</span>
        <span>
          <span class="ar-t">${esc(r.cls || '—')}${r.onDisk ? '' : ' · far side'}</span>
          <span class="ar-s">${r.flares.length} flare${r.flares.length === 1 ? '' : 's'} · last ${esc(Donki.rel(r.recent && r.recent.time))}</span>
        </span>
        <span class="ar-loc">${esc(r.loc)} now ${Math.abs(r.lon).toFixed(0)}°${r.lon >= 0 ? 'E' : 'W'}</span>
      </div>`).join('');
    host.querySelectorAll('.ar-row').forEach(el => {
      el.addEventListener('click', () => this.focus(el.dataset.loc));
      el.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); this.focus(el.dataset.loc); } });
      el.addEventListener('mouseenter', () => { const s = this.spot(el.dataset.loc); if(s) s.classList.add('sel'); });
      el.addEventListener('mouseleave', () => { const s = this.spot(el.dataset.loc); if(s && this.SEL !== el.dataset.loc) s.classList.remove('sel'); });
    });
  },
  spot(loc){ const st = $('sun-stage'); return st ? st.querySelector('.sun-spot[data-loc="' + loc + '"]') : null; },
  wire(){
    const stage = $('sun-stage');
    if(!stage) return;
    stage.querySelectorAll('.sun-spot').forEach(g => {
      g.addEventListener('mousemove', e => this.showTip(g.dataset.loc, e));
      g.addEventListener('mouseleave', () => this.hideTip());
      g.addEventListener('click', () => this.focus(g.dataset.loc));
      g.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); this.focus(g.dataset.loc); } });
    });
  },
  showTip(loc, e){
    const tip = $('sun-tip'), r = this.regions().find(x => x.loc === loc);
    if(!tip || !r) return;
    tip.innerHTML = `<b>AR ${esc(String(r.ar))} · ${esc(r.loc)}</b>`
      + `<span>strongest ${esc(r.cls || '—')} · ${r.flares.length} flare${r.flares.length === 1 ? '' : 's'}</span>`
      + `<span>last event ${esc(Donki.rel(r.recent && r.recent.time))} · ${esc(Donki.hhmm(r.recent && r.recent.time))} UTC</span>`
      + `<span>now at ${Math.abs(r.lat).toFixed(0)}°${r.lat >= 0 ? 'N' : 'S'}, ${Math.abs(r.lon).toFixed(0)}°${r.lon >= 0 ? 'E' : 'W'}</span>`
      + `<span>click to magnify this region</span>`;
    tip.classList.add('show');
    const rect = $('sun-stage').getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = (e.clientX - rect.left) + 14, top = (e.clientY - rect.top) + 12;
    if(left + tw > rect.width - 6) left = rect.width - tw - 8;
    if(top + th > rect.height - 6) top = (e.clientY - rect.top) - th - 12;
    tip.style.left = Math.max(6, left) + 'px';
    tip.style.top = Math.max(6, top) + 'px';
  },
  hideTip(){ const t = $('sun-tip'); if(t) t.classList.remove('show'); },
  /* magnify: the limb is scaled about the stage centre (CSS transform-origin), so bringing
     a point p to the middle means translating by -k·(p − centre) */
  focus(loc){
    this.SEL = loc;
    const r = this.regions().find(x => x.loc === loc);
    if(!r) return;
    const limb = $('sun-limb');
    const k = 2.4;
    if(limb){
      if(r.onDisk){
        const p = this.project(r.lat, r.lon);
        limb.style.transform = `translate(${(-k * (p.x - this.CX)).toFixed(1)}px, ${(-k * (p.y - this.CY)).toFixed(1)}px) scale(${k})`;
      } else {
        limb.style.transform = 'none';
      }
    }
    const host = $('sun-regions');
    if(host) host.querySelectorAll('.ar-row').forEach(el => el.classList.toggle('sel', el.dataset.loc === loc));
    const stage = $('sun-stage');
    if(stage) stage.querySelectorAll('.sun-spot').forEach(el => el.classList.toggle('sel', el.dataset.loc === loc));
    $('sun-note').innerHTML = r.onDisk
      ? `magnified AR ${esc(String(r.ar))} at ${esc(r.loc)} — ${r.flares.length} flare${r.flares.length === 1 ? '' : 's'}, strongest ${esc(r.cls || '—')}, last ${esc(Donki.rel(r.recent && r.recent.time))}.`
      : `AR ${esc(String(r.ar))} has rotated over the far side — its last flare was ${esc(Donki.rel(r.recent && r.recent.time))}, so nothing is visible on the disk.`;
    this.hideTip();
  },
  reset(){
    this.SEL = null;
    const limb = $('sun-limb');
    if(limb) limb.style.transform = 'none';
    this.render();
  }
};

export { SolarDisk };
