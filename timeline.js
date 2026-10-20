import { showView } from '../ui.js';
import { allLaunchesOf } from './missions.js'
/* ================================================================
   Vantage — js/modules/timeline.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */
import { $, Store, httpJSON, esc, fmt, num, isoDate, pad } from '../api.js';
/* ================================================================
   24-hour timeline — one strip over every feed the console already holds
   ================================================================ */
/* count labels for the timeline: "1 launch", not "1 launches" */
function plural(kind, n){
  if(kind === 'pass') return 'pass' + (n === 1 ? '' : 'es');
  if(kind === 'launch') return 'launch' + (n === 1 ? '' : 'es');
  if(kind === 'solar') return 'Kp window' + (n === 1 ? '' : 's');
  return 'storm' + (n === 1 ? '' : 's');
}

/* ================================================================
   NAV BADGES — what these three pages say before you open them
   ================================================================
   The 24-hour page and the jellyfish page sit in the nav beside every other view, and a badge
   is the whole reason they are worth listing there rather than burying: each one answers its
   page's question — how long until the next scheduled event, how many plumes are actually in
   your sky — without the click.
   ================================================================ */
const Badges = {
  /* Keys are the view names, exactly. A typo here throws nothing and breaks nothing visible —
     the badge simply reads “…” for ever, which is the one thing a badge must never do. */
  TARGETS: { jellyfish: 'badge-jf', timeline: 'badge-tl' },
  set(name, text, tone){
    const el = this.TARGETS[name] ? $(this.TARGETS[name]) : null;
    if(!el) return;
    el.textContent = (text === null || text === undefined) ? '…' : String(text);
    el.className = 'nav-badge' + (tone ? ' ' + tone : '');
  }
};

const Timeline = {
  HOURS: 24,
  timer: null, items_: [],
  start(){
    /* wiring comes first, and outside the timer guard, so a second start() can never skip it */
    const b = $('tl-refresh');
    if(b) b.addEventListener('click', () => this.render(true));
    this.render();
    if(this.timer) return;
    this.timer = setInterval(() => this.render(), 30000);
  },
  bump(){ try{ this.render(); }catch(e){} },
  /* This is a page now, so there is nothing to open or close. Entering it re-reads the feeds
     rather than showing whatever was rendered at boot, and showView() does the calling. */
  enter(){ this.render(true); },
  /* Each row of the hourly breakdown is one clock hour from the current hour, and the Kp
     figure is NOAA's 3-hourly forecast bin containing that hour — stated as such rather than
     dressed up as an hourly prediction. */
  hours(){
    const host = $('tl-hours');
    if(!host) return;
    const now = Date.now();
    const start = new Date(now);
    start.setUTCMinutes(0, 0, 0);
    const pred = (typeof Swpc !== 'undefined' && Array.isArray(Swpc.predicted)) ? Swpc.predicted : [];
    /* NOAA publishes Kp in 3-hour bins (00–03Z, 03–06Z…), so the value for an hour is the bin
       that *contains* it — the most recent bin start at or before it — not simply the nearest
       timestamp, which would sometimes borrow from the following bin. */
    const binFor = t => {
      let best = null;
      pred.forEach(p => {
        if(!isFinite(p.t) || p.kp == null) return;
        if(p.t <= t && (t - p.t) < 3 * 3600000 && (!best || p.t > best.t)) best = p;
      });
      return best;
    };
    let rows = '', withKp = 0, withBin = 0;
    for(let i = 0; i < this.HOURS; i++){
      const t0 = start.getTime() + i * 3600000, t1 = t0 + 3600000;
      const bucket = this.items_.filter(it => it.t >= t0 && it.t < t1);
      const hh = new Date(t0).toISOString().slice(11, 16) + 'Z';
      const kp = binFor(t0);
      let kpHtml = '';
      if(kp){
        const gs = Swpc.gScale ? Swpc.gScale(kp.kp) : { g: '', l: '' };
        const cls = kp.kp >= 5 ? ' hot' : kp.kp >= 4 ? ' warm' : '';
        withBin++;
        if(kp.kp >= 4) withKp++;
        kpHtml = `<span class="tl-kp${cls}" title="NOAA 3-hourly Kp forecast for this bin: ${esc(String(kp.kp))}${gs.g ? ' — ' + esc(gs.g) : ''}">Kp ${fmt(kp.kp, 1)}</span>`;
      }
      const ev = bucket.length
        ? bucket.map(it => `<div class="e"><span class="ic">${it.icon}</span><span style="min-width:0"><span class="n">${esc(it.title)}</span>${it.sub ? `<div class="s">${esc(it.sub)}</div>` : ''}</span></div>`).join('')
        : '<div class="none">—</div>';
      rows += `<div class="tl-hr${i === 0 ? ' now' : ''}">`
        + `<div class="h">${hh}${i === 0 ? '<br>now' : ''}</div>`
        + `<div class="ev">${ev}${kpHtml}</div></div>`;
    }
    host.innerHTML = rows;
    const hm = $('tl-hours-meta');
    if(hm){
      let txt = this.items_.length + ' event' + (this.items_.length === 1 ? '' : 's');
      if(withKp) txt += ' · ' + withKp + ' hr Kp ≥ 4';
      /* NOAA rolls its 3-day Kp forecast at the next 00:00Z, so the early hours of a 24-hour
         window often have no bin at all. Saying that out loud is better than leaving those
         rows looking like a failed lookup. */
      txt += withBin
        ? ' · Kp covers ' + withBin + ' of ' + this.HOURS + ' h'
        : ' · no Kp forecast in this window yet';
      hm.textContent = txt;
    }
  },
  /* Everything here is derived from state the other modules already fetched, so the strip
     adds no API calls of its own — and a source that has not loaded yet simply contributes
     nothing rather than blocking the rest. */
  collect(){
    const now = Date.now(), end = now + this.HOURS * 3600000, out = [];
    allLaunchesOf().forEach(l => {
      const t = l.dateObj instanceof Date ? l.dateObj.getTime() : NaN;
      if(!isFinite(t) || t < now || t > end) return;
      out.push({ t: t, kind: 'launch', icon: '🚀', title: l.name, sub: [l.agency, l.rocket, l.pad].filter(Boolean).join(' · '), tag: 'launch', tagCls: 'launch', go: () => { showView('missions'); MissionModal.open(l); } });
    });
    const passes = (typeof PassPredict !== 'undefined' && Array.isArray(PassPredict.data)) ? PassPredict.data : [];
    passes.forEach(p => {
      const rise = (p && p.rise) || {}, culm = (p && p.culmination) || {};
      const t = (num(rise.utc_timestamp) || num(culm.utc_timestamp)) * 1000;
      if(!isFinite(t) || t < now || t > end) return;
      const vis = !!(rise.visible || culm.visible);
      out.push({ t: t, kind: 'pass', icon: '🛰', title: 'ISS pass' + (vis ? ' · visible' : ' · daylight'), sub: 'rises ' + (rise.az_octant || '—') + ', peaks ' + (num(culm.alt) != null ? fmt(culm.alt, 0) + '°' : '—') + ' · above 10° for about ' + Math.max(1, Math.round(((num((p.set || {}).utc_timestamp) || 0) - (num(rise.utc_timestamp) || 0)) / 60)) + ' min', tag: 'pass', tagCls: 'pass', go: () => { showView('overview'); const el = $('pass-list'); if(el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
    });
    const pred = (typeof Swpc !== 'undefined' && Array.isArray(Swpc.predicted)) ? Swpc.predicted : [];
    let lastPeak = null;
    pred.forEach(p => {
      if(!isFinite(p.t) || p.t < now || p.t > end || p.kp == null || p.kp < 5) return;
      /* a run of storm-level intervals is one event in the strip, not one per three hours */
      if(lastPeak && p.t - lastPeak.t <= 3 * 3600000 && p.kp <= lastPeak.kp) return;
      lastPeak = p;
      const gs = Swpc.gScale(p.kp);
      out.push({ t: p.t, kind: 'solar', icon: '☀', title: 'Geomagnetic storm risk · Kp ' + fmt(p.kp, 1), sub: (gs.g ? gs.g + ' · ' + gs.l : gs.l) + ' — NOAA 3-day Kp forecast; aurora may reach further from the poles', tag: 'solar', tagCls: 'solar', go: () => showView('weather') });
    });
    /* active tropical systems are pinned 'now': their only forward-facing timestamp is the
       next advisory, which the public feeds do not publish, and inventing one would be worse
       than saying what is true — this storm is happening */
    const storms = (typeof Storms !== 'undefined' && Array.isArray(Storms.active)) ? Storms.active : [];
    storms.slice(0, 4).forEach(s => {
      const cat = s._cat || Storms.catOf(s.intensity);
      out.push({ t: now + 60000, kind: 'storm', icon: '🌀', title: (s.name || 'Tropical system') + (cat ? ' · ' + cat.l : ''), sub: 'active now · ' + fmt(num(s.intensity) || 0, 0) + ' kt sustained' + (s.advNum ? ' · advisory ' + s.advNum : ''), tag: 'storm', tagCls: 'storm', go: () => showView('events') });
    });
    return out.sort((a, b) => a.t - b.t);
  },
  render(force){
    const track = $('tl-track'), list = $('tl-list'), note = $('tl-note'), meta = $('tl-meta');
    if(!track || !list) return;
    this.items_ = this.collect();
    const now = Date.now(), end = now + this.HOURS * 3600000;
    const pct = t => Math.max(0, Math.min(100, ((t - now) / (end - now)) * 100));
    let html = '<div class="tl-now" style="left:' + pct(now).toFixed(2) + '%"></div>';
    /* Ticks land on round clock hours (00, 03, 06…) so the strip reads against the
       hour-by-hour table beneath it. Anchoring them to "now" instead would put every label
       at :19 past, which lines up with nothing. */
    for(let t = Math.ceil(now / 3600000) * 3600000; t < end; t += 3600000){
      const d = new Date(t);
      if(d.getUTCHours() % 3 !== 0) continue;
      html += `<div class="tl-tick ${d.getUTCHours() % 6 === 0 ? 'h6' : ''}" style="left:${pct(t).toFixed(2)}%"><span>${esc(d.toISOString().slice(11, 16))}Z</span></div>`;
    }
    const lanes = { 0: 0, 1: 0 };
    this.items_.forEach((it, i) => {
      /* launches and solar warnings sit on the upper lane; recurring passes do not, so a
         heavily-passing day cannot bury the things a viewer actually plans around */
      const lane = (it.kind === 'pass') ? 1 : 0;
      lanes[lane] = (lanes[lane] || 0) + 1;
      const laneCls = lane ? ' lane2' : '';
      const w = pct(it.t);
      /* keep the marker inside the strip so its label cannot be clipped off the edge */
      const left = Math.max(1.5, Math.min(98.5, w));
      const dot = it.tagCls === 'storm' ? 'var(--hot)' : it.tagCls === 'solar' ? 'var(--warm)' : it.tagCls === 'pass' ? 'var(--accent-2)' : 'var(--accent)';
      html += `<button class="tl-item${laneCls}" data-tl="${i}" style="left:${left.toFixed(2)}%" `
        + `title="${esc(new Date(it.t).toISOString().slice(11, 16))}Z · ${esc(it.title)}" aria-label="${esc(it.title)} at ${esc(new Date(it.t).toISOString().slice(11, 16))} UTC">`
        + `<span class="tl-dot" style="background:${dot}"></span>`
        + (lane ? '' : `<span class="tl-lab">${esc(it.icon)} ${esc(new Date(it.t).toISOString().slice(11, 16))}</span>`)
        + '</button>';
    });
    track.innerHTML = html;
    track.querySelectorAll('[data-tl]').forEach(b => b.addEventListener('click', () => {
      const it = this.items_[Number(b.dataset.tl)];
      if(it && typeof it.go === 'function') it.go();
    }));
    if(!this.items_.length){
      list.innerHTML = '<div class="empty">Nothing scheduled in the next 24 hours from the feeds currently loaded — launches, ISS passes and storm-level Kp windows will appear here as they arrive.</div>';
    } else {
      list.innerHTML = this.items_.slice(0, 8).map((it, i) => {
        const mins = Math.round((it.t - now) / 60000);
        const when = mins <= 1 ? 'now' : mins < 60 ? 'in ' + mins + ' min' : 'in ' + Math.floor(mins / 60) + 'h ' + pad(mins % 60) + 'm';
        return `<button class="tl-li" data-tl2="${i}"><span class="w">${esc(when)}<br>${esc(new Date(it.t).toISOString().slice(11, 16))}Z</span>`
          + `<span class="i">${it.icon}</span>`
          + `<span><span class="n">${esc(it.title)}</span><span class="s">${esc(it.sub)}</span></span>`
          + `<span class="tag ${it.tagCls}">${esc(it.tag)}</span></button>`;
      }).join('');
      list.querySelectorAll('[data-tl2]').forEach(b => b.addEventListener('click', () => {
        const it = this.items_[Number(b.dataset.tl2)];
        if(it && typeof it.go === 'function') it.go();
      }));
    }
    const counts = this.items_.reduce((a, it) => { a[it.kind] = (a[it.kind] || 0) + 1; return a; }, {});
    if(note) note.innerHTML = this.items_.length
      ? `live from the loaded feeds${force ? ' · refreshed' : ''}`
      : 'waiting on feeds — the strip fills itself as sections load';
    if(meta) meta.textContent = this.items_.length
      ? Object.keys(counts).map(k => counts[k] + ' ' + plural(k, counts[k])).join(' · ')
      : 'nothing in window yet';
    /* the nav badge is this channel's whole reason for being listed: it answers before the
       panel is opened. Minutes when the next event is close, hours when it is not. */
    const next = this.items_.find(it => isFinite(it.t) && it.t >= now);
    if(!next){
      Badges.set('timeline', 'quiet', '');
    } else {
      const mins = Math.round((next.t - now) / 60000);
      Badges.set('timeline', mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h', mins < 60 ? 'live' : '');
    }
    this.hours();
  }
};

export { Timeline, Badges, plural };
