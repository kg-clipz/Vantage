import { Badges } from './timeline.js';
import { toast } from '../ui.js';
import { allLaunchesOf } from './missions.js'
/* ================================================================
   Vantage — js/modules/jellyfish.js
   ================================================================ */
import { $, Store, esc, fmt, num, isoDate, pad } from '../api.js';
/* ================================================================
   Space jellyfish watch — a launch is a jellyfish candidate only when the
   pad is in twilight at lift-off while the vehicle climbs into sunlight.
   Since that is pure geometry, it can be computed rather than fetched:
   the Sun's elevation at the pad coordinates at the scheduled T-0.
   ================================================================ */
const Jellyfish = {
  R: 6371,          // mean Earth radius, km
  ALT: 200,         // the altitude the plume is judged at, km
  /* The plume is lit whenever the pad's Sun is no more than the dip angle of a 200 km
     sightline below the horizon — acos(R / (R + 200)) ≈ 14.2°. Past that the exhaust itself
     is inside Earth's shadow and no observer anywhere can see it lit. */
  LIT: -14.2,
  /* Geometrically a 200 km plume stays in line of sight out to ~1,600 km, but haze, moonlight
     and light pollution swallow the low sky long before that, so the outlook stops calling
     itself useful past this range rather than promising a sight nobody gets. */
  RANGE: 1200,
  /* The observer's own half of the condition. Below this solar elevation the sky at ground
     level is dark enough to pick the plume out; above it the plume is dimmer than the sky it
     sits in. The per-launch verdict and the ground-band search must agree, so both read it
     from here. */
  DARK: -0.8,
  /* A sightline less than this high is technically above the horizon and practically
     unusable — haze and terrain own the last degree or two, so a band is only reported where
     the plume genuinely rides clear of it. */
  MIN_PE: 1.5,
  /* The viewpoint controls live in this panel but drive the *shared* observer, so the ISS pass
     predictor and the jellyfish outlook can never point at two different places. The console's
     own starting coordinates are the reset target — resetting to "unset" would leave the pass
     card showing a validation error. The default is NASA headquarters: members of the public
     watch launches from there, so the jellyfish answer starts where the audience starts. */
  HOME: { lat: 38.8521, lon: -77.0419, label: 'NASA Headquarters, Washington DC (console default)' },
  PLACE_KEY: 'vantage-jf-place',
  PREF_KEY: 'vantage-jf-visible',
  /* Resolution of the ground search: 10° of azimuth and 100 km of range. Finer than the
     physics needs (the terminator moves ~0.25°/minute, so the bands shift slowly) and coarse
     enough that a whole manifest costs a few thousand pieces of trigonometry, not a stall. */
  AZ_STEP: 10,
  KM_STEP: 100,
  /* Key-less and CORS-open (verified: access-control-allow-origin: *), so naming a place costs
     no NASA quota — which is the whole reason the panel can offer a search box at all. */
  GEO: 'https://geocoding-api.open-meteo.com/v1/search',
  /* Low-precision solar position (NOAA / USNO), accurate to well under a degree for decades
     either side of J2000 — far finer than the twilight bands it has to resolve, and it needs
     no network call, which is the whole point. */
  sunElev(ms, latDeg, lonDeg){
    const rad = Math.PI / 180;
    const d = ms / 86400000 + 2440587.5 - 2451545.0;                 // days since J2000
    const g = (357.529 + 0.98560028 * d) * rad;                      // mean anomaly
    const q = 280.459 + 0.98564736 * d;                              // mean longitude
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;   // ecliptic longitude
    const e = (23.439 - 0.00000036 * d) * rad;                       // obliquity
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const raDeg = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;        // Greenwich sidereal, hours
    const lstDeg = gmst * 15 + lonDeg;
    const ha = (((lstDeg - raDeg) + 540) % 360) - 180;               // hour angle, degrees
    return Math.asin(Math.sin(latDeg * rad) * Math.sin(dec)
      + Math.cos(latDeg * rad) * Math.cos(dec) * Math.cos(ha * rad)) / rad;
  },
  /* The bands. Only the negative ones matter: the observer must be dark while the plume
     at 100–300 km is not. */
  band(el){
    if(el == null) return { label: 'pad coordinates unavailable', cls: '', why: 'this launch did not carry pad coordinates, so the solar geometry cannot be worked out' };
    if(el >= 10) return { label: 'daylight', cls: '', why: 'the sky is far too bright for the plume to stand out — you would see an ordinary white trail' };
    if(el >= 0) return { label: 'sun still up', cls: 'maybe', why: 'the Sun is on the horizon but the sky is still bright — a weak or partial effect at best' };
    if(el > -6) return { label: 'civil twilight · prime', cls: 'good', why: 'the classic window — ground dark, the atmosphere at 200 km still in direct sunlight' };
    if(el > -12) return { label: 'nautical twilight · good', cls: 'good', why: 'ground properly dark and the high plume still lit — often the best photographs' };
    if(el > -18) return { label: 'astronomical twilight', cls: 'maybe', why: 'possible, but only the very top of the trajectory is still sunlit by T+3 min' };
    return { label: 'full night', cls: '', why: 'the ground and the lower plume are both in shadow — nothing to catch the light' };
  },

  /* ---- where it would be visible from ---------------------------------------------------
     The observer is the same location the pass predictor uses, deliberately: two observer
     points in one console drift apart and then contradict each other. This panel therefore
     offers its own *controls* — a place search, coordinates, pad presets — but they all write
     through to that one observer instead of keeping a second copy of it. */
  obs(){
    const la = num($('pass-lat') ? $('pass-lat').value : null);
    const lo = num($('pass-lon') ? $('pass-lon').value : null);
    if(la == null || lo == null || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    return { lat: la, lon: lo };
  },
  /* The name attached to a viewpoint is cosmetic, so it lives in its own key: the pass
     predictor rewrites LOC_KEY on every successful fetch and would otherwise drop it. */
  label(o){
    if(!o) return '';
    const p = Store.getJSON(this.PLACE_KEY, null);
    if(!p || !p.label) return '';
    return (Math.abs(num(p.lat) - o.lat) < 0.0002 && Math.abs(num(p.lon) - o.lon) < 0.0002)
      ? String(p.label) : '';
  },
  /* Mirror the shared observer back into this panel's own fields — but never over a field the
     viewer is typing into, or the caret is yanked out from under them mid-coordinate. */
  syncInputs(){
    const o = this.obs(), l = $('jf-lat'), lo = $('jf-lon');
    if(l && document.activeElement !== l) l.value = o ? String(o.lat) : '';
    if(lo && document.activeElement !== lo) lo.value = o ? String(o.lon) : '';
  },
  setObserver(lat, lon, label, opts){
    const o = opts || {};
    const la = num(lat), lo = num(lon);
    if(typeof PassPredict === 'undefined' || !PassPredict.valid(la, lo)){
      if(!o.quiet) toast('That is not a usable latitude and longitude pair');
      return false;
    }
    const pl = $('pass-lat'), po = $('pass-lon');
    if(pl) pl.value = la.toFixed(4);
    if(po) po.value = lo.toFixed(4);
    Store.setJSON(this.PLACE_KEY, label ? { lat: la, lon: lo, label: label } : null);
    this.syncInputs();
    this.hideHits();
    this.render();
    /* one observer, so the ISS pass list belongs to it as well — run(false) reuses the
       30-minute per-location cache and only reaches the network for a location not seen yet */
    try{ PassPredict.run(false); }catch(e){}
    if(!o.quiet){
      toast(label ? 'Viewpoint moved to ' + label + ' — the ISS pass list follows it'
        : 'Viewpoint updated — the ISS pass list follows it');
    }
    return true;
  },
  reset(){
    this.setObserver(this.HOME.lat, this.HOME.lon, this.HOME.label, { quiet: true });
    toast('Viewpoint reset to the console default, ' + this.HOME.label);
  },
  dist(la1, lo1, la2, lo2){
    const rad = Math.PI / 180;
    const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
    const a = Math.sin(dLa / 2) * Math.sin(dLa / 2)
      + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * this.R * Math.asin(Math.min(1, Math.sqrt(a)));
  },
  bearing(la1, lo1, la2, lo2){
    const rad = Math.PI / 180;
    const y = Math.sin((lo2 - lo1) * rad) * Math.cos(la2 * rad);
    const x = Math.cos(la1 * rad) * Math.sin(la2 * rad)
      - Math.sin(la1 * rad) * Math.cos(la2 * rad) * Math.cos((lo2 - lo1) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  },
  compass(deg){
    const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return pts[Math.round(deg / 22.5) % 16];
  },
  /* How high the plume sits above the observer's own horizon. The surface drops away as
     d²/2R under a straight sightline, so the apparent altitude is less than the true one:
     33° from 300 km, but only 7° from 1,000 km. */
  plumeElev(distKm, altKm){
    const d = Math.max(distKm, 1);
    return Math.atan2(altKm - (d * d) / (2 * this.R), d) / (Math.PI / 180);
  },

  /* ---- where on the ground it is visible from -------------------------------------------
     "Where is it visible from?" has a real answer, because at one instant the Sun's elevation
     is a function of position: "who is dark" is a geographic band — the terminator. Sampling
     rings of azimuths around the pad and testing each point for both halves of the condition
     (observer dark, plume clear of their horizon) turns that into the wedges where a sighting
     exists. It is trigonometry only: no map, no feed, no key.
     Bearings here are pad → observer, i.e. where to *stand*, not where to look. */
  dest(laDeg, loDeg, brgDeg, distKm){
    const rad = Math.PI / 180;
    const d = distKm / this.R, la1 = laDeg * rad, br1 = brgDeg * rad;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br1));
    const lo2 = loDeg * rad + Math.atan2(Math.sin(br1) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return { lat: la2 / rad, lon: ((lo2 / rad + 540) % 360) - 180 };
  },
  /* How far out a sighting survives, scanned outward along one bearing. The reach is *not*
     the same in every direction — the terminator is a line, so the far side of the pad stays
     dark for longer while the day side is lit within a few hundred kilometres. A single
     "visible out to N km" figure would therefore be wrong in one direction or the other, so
     the search returns a reach per bearing and groups it into compass sectors. */
  reachAlong(x, az){
    let reach = 0;
    for(let d = this.KM_STEP; d <= this.RANGE; d += this.KM_STEP){
      const p = this.dest(x.l.padLat, x.l.padLon, az, d);
      if(this.sunElev(x.t, p.lat, p.lon) > this.DARK) break;   // their sky is not dark yet
      if(this.plumeElev(d, this.ALT) <= this.MIN_PE) break;    // no usable sightline to the plume
      reach = d;
    }
    return reach;
  },
  ground(x){
    if(!x || x.el == null || !isFinite(x.t) || x.el <= this.LIT) return null;
    const per = [];
    for(let az = 0; az < 360; az += this.AZ_STEP) per.push({ az: az, reach: this.reachAlong(x, az) });
    if(!per.some(p => p.reach)) return null;
    const max = per.reduce((a, p) => Math.max(a, p.reach), 0);
    /* eight 45° sectors centred on the compass points, so the answer reads as directions a
       viewer already owns rather than as azimuth ranges */
    const sectors = [];
    for(let c = 0; c < 360; c += 45){
      let reach = 0;
      /* matched by angular distance rather than by index arithmetic, so a sector is correct
         whatever the azimuth step is — the earlier index form silently floor-dropped halves */
      per.forEach(p => {
        if(Math.abs(((p.az - c + 540) % 360) - 180) <= 22.5) reach = Math.max(reach, p.reach);
      });
      sectors.push({ c: c, card: this.compass(c), reach: reach });
    }
    const far = sectors.filter(s => s.reach === max);
    const short = sectors.filter(s => s.reach > 0 && s.reach < max);
    const none = sectors.filter(s => !s.reach);
    const near = short.length ? Math.min.apply(null, short.map(s => s.reach)) : max;
    return {
      per: per, sectors: sectors, max: max, far: far, short: short, none: none, all: sectors.length,
      /* the figure and the direction it belongs to: quoting the minimum against a whole group
         would understate every sector in it but one */
      near: near, lowest: short.filter(s => s.reach === near)
    };
  },
  /* Contiguous sectors collapse to a range (W–NW); separated ones are listed, because "W–E"
     would claim a swathe the answer never meant. */
  names(list){
    const order = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = list.map(s => order.indexOf(s.card)).filter(i => i >= 0).sort((a, b) => a - b);
    if(!idx.length) return '';
    if(idx.length === order.length) return 'all round';
    const runs = [];
    let start = idx[0];
    for(let i = 1; i <= idx.length; i++){
      if(i < idx.length && idx[i] === idx[i - 1] + 1) continue;
      runs.push([start, idx[i - 1]]);
      if(i < idx.length) start = idx[i];
    }
    /* a run that ends at NW and one that starts at N are neighbours through north */
    if(runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === order.length - 1){
      const last = runs.pop();
      runs[0] = [last[0], runs[0][1] + order.length];
    }
    return runs.map(r => r[0] === r[1] ? order[r[0] % order.length]
      : order[r[0] % order.length] + '–' + order[r[1] % order.length]).join(', ');
  },
  /* The ground answer, phrased once so the headline and the rows cannot disagree. Whatever is
     named is named as the *smaller* of the two sides, both because the short side is the
     interesting one and because a run of five or six sectors has no readable compass range —
     "S–N" would claim a sweep the finding never meant. */
  whereText(g){
    if(!g) return '';
    const max = 'out to about <b>' + fmt(g.max, 0) + ' km</b>';
    const low = g.short.concat(g.none);
    if(!low.length) return max + ' in every direction from the pad';
    if(!g.short.length) return max + ' in most directions, but nothing at all to the <b>' + esc(this.names(g.none)) + '</b>';
    if(low.length <= g.far.length){
      const bits = [];
      if(g.short.length) bits.push('about <b>' + fmt(g.near, 0) + ' km</b> to the <b>' + esc(this.names(g.lowest)) + '</b>');
      if(g.none.length) bits.push('nothing at all to the <b>' + esc(this.names(g.none)) + '</b>');
      return max + ' in most directions from the pad, but only ' + bits.join(', and ');
    }
    return max + ' on the <b>' + esc(this.names(g.far)) + '</b> side of the pad, and as little as about <b>'
      + fmt(g.near, 0) + ' km</b> further round — the lit layer is cut short wherever the Sun is still up';
  },
  /* The verdict for one launch, from one observer. rank drives the ordering: visible from you
     first, then twilight candidates, then everything else. */
  outlook(x, o){
    const base = k => ({ k: k, label: '', why: '', d: null, brg: null, pe: null, oe: null });
    /* visible-from-you first, then twilight candidates, then the rest */
    const order = k => (k === 'yes' ? 0 : k === 'part' ? 10 : 20) + (x.b.cls === 'good' ? 0 : 1);
    if(x.el == null){
      const v = base('no');
      v.label = 'cannot tell';
      v.why = 'this launch carries no pad coordinates, so nothing can be worked out for it.';
      v.rank = order(v.k);
      return v;
    }
    if(x.el <= this.LIT){
      const v = base('no');
      v.label = 'plume unlit';
      v.why = 'the Sun is already below the lit layer, so the exhaust itself is in shadow — there is nothing to see from anywhere.';
      v.rank = order(v.k);
      return v;
    }
    if(!o){
      const v = base('part');
      v.label = 'set your location';
      v.why = 'the plume can catch the light, but without your coordinates there is no way to say whether it points at you.';
      v.rank = order(v.k);
      return v;
    }
    const d = this.dist(o.lat, o.lon, x.l.padLat, x.l.padLon);
    const brg = this.bearing(o.lat, o.lon, x.l.padLat, x.l.padLon);
    const pe = this.plumeElev(d, this.ALT);
    const oe = this.sunElev(x.t, o.lat, o.lon);
    const v = { k: 'part', label: '', why: '', d: d, brg: brg, pe: pe, oe: oe, rank: 0 };
    if(d > this.RANGE){
      v.k = 'no'; v.label = 'beyond range';
      v.why = 'at that distance the lit plume is over the curve of the Earth for you' + (pe <= 0 ? ' — it sits below your horizon entirely' : '') + ', and haze and light pollution take the low sky long before the geometric limit of about 1,600 km.';
    } else if(oe > this.DARK){
      v.k = 'no'; v.label = 'your sky too bright';
      v.why = 'the Sun is still up where you are (elevation ' + fmt(oe, 1) + '°), and the plume is dimmer than the sky it would sit in.';
    } else {
      v.k = 'yes'; v.label = 'visible from you';
      /* two different routes to a lit plume, and they read very differently at the pad: a pad
         still in daylight guarantees the lit layer, while a pad in twilight is the window the
         phenomenon is usually photographed in. Both only need *your* sky to be dark. */
      v.why = x.el >= 0
        ? 'the pad itself is still in daylight, so the plume is certainly lit, and your own sky is already dark (' + fmt(oe, 1) + '°) — which is all that is left to ask for.'
        : 'you are already in twilight (' + fmt(oe, 1) + '° at your ground) while the atmosphere above the pad is still lit, which is the combination the phenomenon needs.';
    }
    v.rank = order(v.k);
    return v;
  },
  items(){
    const now = Date.now();
    const o = this.obs();
    const out = allLaunchesOf().map(l => {
      const t = l.dateObj instanceof Date ? l.dateObj.getTime() : NaN;
      const el = (isFinite(t) && l.padLat != null && l.padLon != null)
        ? this.sunElev(t, l.padLat, l.padLon) : null;
      const x = { l: l, t: t, el: el, b: this.band(el) };
      x.v = this.outlook(x, o);
      return x;
    })      .filter(x => isFinite(x.t) && x.t > now - 3600000)
      .sort((a, b) => (a.v.rank - b.v.rank) || (a.t - b.t));
    /* the ground answer is worked out here, for every launch in the window, so the headline
       and the rows read from one computation instead of two */
    out.forEach(x => { x.g = this.ground(x); });
    /* candidates first, then the rest — this is a watch list, not a manifest */
    const good = out.filter(x => x.b.cls === 'good');
    const seen = out.filter(x => x.v.k === 'yes');
    return {
      good: good, cands: out,
      all: this.visibleOnly ? seen.slice(0, 8) : out.slice(0, 8),
      total: out.length, hits: seen.length, o: o
    };
  },
  row(x){
    const l = x.l, v = x.v;
    const when = isFinite(x.t) ? new Date(x.t).toISOString().slice(5, 16).replace('T', ' ') + 'Z' : '—';
    const padTxt = l.pad || 'pad not listed';
    /* LL2 titles a mission "VEHICLE | Payload", and the manifest falls back to that prefix when
       a launch carries no rocket name — printing both lines the vehicle name out twice */
    const veh = l.rocket || '';
    let mis = l.name || 'Unnamed mission';
    if(veh && mis.toLowerCase().indexOf(veh.toLowerCase() + ' |') === 0){
      mis = mis.slice(veh.length).replace(/^\s*\|\s*/, '');
    }
    const elTxt = x.el == null ? 'sun position unknown' : 'sun ' + (x.el >= 0 ? '+' : '') + fmt(x.el, 1) + '° at the pad';
    /* the sighting line is the point of the panel: distance, the direction to look, how high
       the plume rides above the viewer's horizon, and the viewer's own solar elevation */
    /* a plume below the observer's horizon has a negative apparent altitude, and printing that
       as "-31° above your horizon" is arithmetic that reads as nonsense — so the height is only
       quoted when there is a sightline to quote it for */
    /* standing at the pad is its own case: a bearing to yourself is meaningless, and the pad
       chips in the viewpoint section make this a one-click situation rather than a curiosity */
    const atPad = v.d != null && v.d < 2;
    const sight = v.d == null
      ? `<b>No sighting anywhere:</b> ${esc(v.why)}`
      : atPad
        ? `<b>From your location:</b> you are at the pad itself, so the plume rises almost overhead`
          + (v.pe > 0 ? ` — about <b>${fmt(v.pe, 0)}°</b> up` : '')
          + `, and distance is no obstacle at all. ${esc(v.why)}`
        : `<b>From your location:</b> the pad is <b>${fmt(v.d, 0)} km</b> away on a bearing of <b>${this.compass(v.brg)}</b> (${fmt(v.brg, 0)}°)`
          + (v.pe > 0 ? `, and the plume would ride about <b>${fmt(v.pe, 0)}°</b> above your horizon` : '')
          + `. ${esc(v.why)}`;
    /* the other half of "where is it visible from": not your single point, but the whole band
       on the ground where both halves of the condition hold */
    const band = x.g
      ? `<span class="band">Sighting band from the ground: ${this.whereText(x.g)}.</span>`
      : '';
    return `<div class="jf-s">
      <div>
        <div class="veh">${esc(l.rocket || 'Unknown vehicle')}</div>
        <div class="mis">${esc(mis)}${l.agency ? ' · ' + esc(l.agency) : ''}</div>
        <div class="when">${esc(padTxt)} · NET ${esc(when)} · ${esc(elTxt)}</div>
      </div>
      <div class="jf-tags">
        <span class="jf-tag${x.b.cls ? ' ' + x.b.cls : ''}">${esc(x.b.label)}</span>
        <span class="jf-verdict ${v.k}">${esc(v.label)}</span>
      </div>
      <div class="from">${sight}${band}</div>
    </div>`;
  },
  paintObserver(o){
    const el = $('jf-ob-coords');
    if(!el) return;
    const lab = this.label(o);
    el.textContent = o
      ? fmt(o.lat, 3) + '°, ' + fmt(o.lon, 3) + '°' + (lab ? ' · ' + lab : '')
      : 'not set — the outlook cannot say which way the plume points';
  },
  paintVisible(){
    const b = $('jf-visible');
    if(!b) return;
    b.textContent = 'only what I could see: ' + (this.visibleOnly ? 'on' : 'off');
    b.setAttribute('aria-pressed', String(this.visibleOnly));
    b.classList.toggle('primary', this.visibleOnly);
  },
  toggleVisible(){
    this.visibleOnly = !this.visibleOnly;
    Store.set(this.PREF_KEY, this.visibleOnly ? '1' : '0');
    this.render();
  },
  /* Viewpoints the manifest itself supplies: a pad is the one place a plume is certain to pass
     overhead. The chips are rebuilt only when the set of pads changes, so they neither flicker
     nor lose focus on the 30-second repaint. */
  pads(){
    const seen = {}, out = [];
    allLaunchesOf().forEach(l => {
      if(l.padLat == null || l.padLon == null) return;
      const k = l.padLat.toFixed(2) + ',' + l.padLon.toFixed(2);
      if(seen[k]){ seen[k].n++; return; }
      /* LL2 titles a pad "PAD · SITE, REGION, COUNTRY". The site is what a viewer recognises
         as a place to stand, so that is the chip; the full pad string stays in its tooltip. */
      const full = String(l.pad || 'Pad').split(',')[0].trim();
      const seg = full.split('·');
      seen[k] = { k: k, lat: l.padLat, lon: l.padLon, n: 1, full: full, name: seg[seg.length - 1].trim() };
      out.push(seen[k]);
    });
    return out.slice(0, 8);
  },
  paintChips(){
    const host = $('jf-presets');
    if(!host) return;
    const pads = this.pads();
    const sig = pads.map(p => p.k + ':' + p.full).join('|');
    if(sig === this.chipSig) return;
    this.chipSig = sig;
    if(!pads.length){
      host.innerHTML = '<span class="loading">pad viewpoints appear with the manifest</span>';
      return;
    }
    host.innerHTML = pads.map((p, i) => `<button class="jf-chip" data-jf-pad="${i}" title="Stand at ${esc(p.full)} — ${p.n} launch${p.n === 1 ? '' : 'es'} on the manifest lift from here" aria-label="Set the viewpoint to ${esc(p.full)}">${esc(p.name)}</button>`).join('');
    host.querySelectorAll('[data-jf-pad]').forEach(b => b.addEventListener('click', () => {
      const p = pads[Number(b.dataset.jfPad)];
      if(p) this.setObserver(p.lat, p.lon, p.name, {});
    }));
  },
  hitsMsg(msg){
    const hits = $('jf-hits');
    if(!hits) return;
    if(!msg){ hits.hidden = true; return; }
    hits.innerHTML = '<div class="none">' + esc(msg) + '</div>';
    hits.hidden = false;
  },
  hideHits(){ this.hitsMsg(''); },
  /* A place name is a convenience, never a dependency. The geocoder is free and key-less (so it
     spends no NASA quota), and if it is unreachable the coordinates below still do the whole
     job — which is why a failed lookup never blocks the predictor. */
  async place(){
    const input = $('jf-place'), hits = $('jf-hits'), note = $('jf-note');
    const q = input ? input.value.trim() : '';
    if(q.length < 2){
      this.hitsMsg('Type at least two letters of a place name — or use the coordinates below.');
      return;
    }
    if(!hits) return;
    if(note) note.textContent = 'looking up “' + q + '”…';
    try{
      const res = await fetchWithTimeout(this.GEO + '?name=' + encodeURIComponent(q) + '&count=6&language=en&format=json', 10000);
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const list = (d && Array.isArray(d.results)) ? d.results : [];
      if(!list.length){
        this.hitsMsg('No place called “' + q + '” was found. Try a nearby larger town, or type the coordinates below.');
        return;
      }
      hits.innerHTML = list.map((p, i) => `<button data-jf-hit="${i}" title="Use this place as the viewpoint">`
        + `<span class="where">${esc(p.name)}<span class="sub">${esc([p.admin1, p.country].filter(Boolean).join(', ') || '—')}</span></span>`
        + `<span class="mono">${fmt(p.latitude, 2)}°, ${fmt(p.longitude, 2)}°</span></button>`).join('');
      hits.hidden = false;
      hits.querySelectorAll('[data-jf-hit]').forEach(b => b.addEventListener('click', () => {
        const p = list[Number(b.dataset.jfHit)];
        if(!p) return;
        this.setObserver(p.latitude, p.longitude, p.name + (p.country ? ', ' + p.country : ''));
        if(input) input.value = '';
      }));
      if(note) note.textContent = list.length + ' match' + (list.length === 1 ? '' : 'es') + ' — pick one';
    }catch(e){
      this.hitsMsg('The place lookup could not be reached — it is a free key-less service. Type the latitude and longitude below instead; the outlook does not need the name.');
    }
  },
  /* The headline answers the panel's own question — where on Earth can this be seen from — for
     whichever launch is best placed. */
  paintArc(r){
    const el = $('jf-arc');
    if(!el) return;
    const pick = r.cands.find(x => x.g) || null;
    if(!pick){
      el.className = 'jf-arc none';
      const lit = r.cands.filter(x => x.el != null && x.el > this.LIT).length;
      el.textContent = !r.cands.length
        ? 'No launch in the window yet — this line states which places on the ground the next plume could be seen from.'
        : lit === 0
          ? 'Every launch loaded has its exhaust already inside Earth’s shadow at lift-off, so there is no lit plume anywhere on the ground to look at.'
          : 'The plume is lit for ' + lit + ' of these launches, but no ground point within ' + fmt(this.RANGE, 0) + ' km is dark enough at that moment — the sightline gives out before it reaches anyone.';
      return;
    }
    const when = isFinite(pick.t) ? new Date(pick.t).toISOString().slice(5, 16).replace('T', ' ') + 'Z' : 'time still TBD';
    el.className = 'jf-arc';
    el.innerHTML = `<b>${esc(pick.l.rocket || pick.l.name || 'Next candidate')}</b> · NET ${esc(when)} — `
      + `a dark sky is all a viewer needs: the plume is visible from the ground ${this.whereText(pick.g)}.`;
  },
  render(){
    const host = $('jf-watch');
    if(!host) return;
    this.syncInputs();
    const r = this.items();
    this.paintObserver(r.o);
    this.paintVisible();
    this.paintChips();
    this.paintArc(r);
    const meta = $('jf-meta');
    if(meta) meta.textContent = r.total
      ? r.good.length + ' of ' + r.total + ' in a twilight window'
      : 'no launches in the manifest';
    /* what the nav badge says before this panel is opened: how many plumes are actually in
       the viewer's sky, falling back to how many have a twilight window at all */
    Badges.set('jellyfish', r.hits ? r.hits + ' seen'
      : r.good.length ? r.good.length + ' window' + (r.good.length === 1 ? '' : 's') : 'none',
      r.hits ? 'live' : '');
    const om = $('jf-ob-meta');
    if(om){
      om.textContent = !r.o ? 'viewpoint not set'
        : r.hits ? r.hits + ' sightline' + (r.hits === 1 ? '' : 's') + ' from here'
        : 'none pointed at this viewpoint';
    }
    const note = $('jf-note');
    if(note){
      note.textContent = this.visibleOnly
        ? r.all.length + ' of ' + r.total + ' inside your sky'
        : r.total + ' launches in the window · ' + r.hits + ' sightline' + (r.hits === 1 ? '' : 's') + ' from here';
    }
    if(!r.all.length){
      host.innerHTML = this.visibleOnly
        ? '<div class="empty">Nothing on the manifest would put its plume in your sky as things stand. The filter is on — the button above lists every launch with its twilight band instead.</div>'
        : '<div class="empty">No upcoming launches loaded yet — the watch list fills itself from the same manifest as the Missions table.</div>';
      return;
    }
    host.innerHTML = r.all.map(x => this.row(x)).join('');
  },
  async geo(){
    if(!navigator.geolocation){ toast('This browser has no location API — search for a place or type coordinates instead'); return; }
    const note = $('jf-note');
    if(note) note.textContent = 'asking the browser for your location…';
    try{
      const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 12000, maximumAge: 600000 }));
      this.setObserver(pos.coords.latitude, pos.coords.longitude, 'this device', { quiet: true });
      toast('Viewpoint set from this device — the ISS pass list follows it');
    }catch(e){
      const why = e && e.code === 1 ? 'Location permission was refused'
        : e && e.code === 3 ? 'The location request timed out' : 'Your location is unavailable';
      toast(why + ' — search for a place or type coordinates instead');
    }
  },

  /* ---- the jellyfish page ------------------------------------------------------------------ */
  /* A page, not a panel: entering it recomputes against the current viewpoint, and there is
     nothing to open, close or focus. */
  enter(){ this.render(); },
  /* wiring runs at boot, so a handler can never be installed only by the very click that needs
     it — the refresh button is the only control that is not inside the page's own markup */
  init(){
    const r = $('jf-refresh');
    if(r) r.addEventListener('click', () => this.render());
    const g = $('jf-geo');
    if(g) g.addEventListener('click', () => this.geo());
    const cl = $('jf-clear');
    if(cl) cl.addEventListener('click', () => this.reset());
    const vis = $('jf-visible');
    if(vis) vis.addEventListener('click', () => this.toggleVisible());
    /* the channel chips in this header are handled by Dock's delegated listener, the same one
       that drives the nav rows and the chips in the other two panels */
    const pi = $('jf-place');
    if(pi) pi.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); this.place(); } });
    const pg = $('jf-place-go');
    if(pg) pg.addEventListener('click', () => this.place());
    ['jf-lat', 'jf-lon'].forEach(id => {
      const el = $(id);
      if(!el) return;
      el.addEventListener('change', () => {
        const la = num($('jf-lat').value), lo = num($('jf-lon').value);
        if(la == null || lo == null){ this.syncInputs(); return; }   // half a pair is not a viewpoint
        this.setObserver(la, lo, '');
      });
      el.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); el.blur(); } });
    });
    this.visibleOnly = Store.get(this.PREF_KEY, '0') === '1';
    this.paintVisible();
    this.paintChips();
    this.syncInputs();
    this.paintObserver(this.obs());
  }
};

export { Jellyfish };
