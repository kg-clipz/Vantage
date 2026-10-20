import { Badges } from './timeline.js';
import { allNeosOf } from './asteroids.js';
import { allLaunchesOf, statusClass, liveKv } from './missions.js'
/* ================================================================
   Vantage — js/modules/mission.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */
import { $, Store, httpJSON, esc, fmt, num, isoDate, ApiCache, pad, Retry } from '../api.js';
/* ================================================================
   Mission dossier — every launch row is a door into the manifest
   ================================================================ */
/* Launch Library publishes its countdown offsets as ISO-8601 durations ("-PT38M"), which
   are a poor thing to put in front of a viewer, so they are parsed once into seconds. */
function isoDur(s){
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
  if(!m) return null;
  const sign = m[1] ? -1 : 1;
  return sign * ((Number(m[2]) || 0) * 86400 + (Number(m[3]) || 0) * 3600 + (Number(m[4]) || 0) * 60 + (Number(m[5]) || 0));
}
function durLabel(sec){
  if(sec == null || !isFinite(sec)) return '—';
  const s = Math.abs(Math.round(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (sec < 0 ? 'T–' : 'T+') + (d ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(ss);
}
function utcStamp(d){
  if(!(d instanceof Date) || isNaN(d)) return '—';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
const MissionModal = {
  /* The detail endpoint is a *second* request against a free tier that allows only a handful
     per hour, so a row opened twice is served from the in-memory memo and then from the shared
     cache — and when the request is refused outright the dossier is still assembled from the
     manifest row itself instead of showing an error where the mission should be. */
  TTL: 6 * 3600 * 1000,
  memo: {},
  cur: null, detail: null, fail: '', timer: null, wired: false, loading: false,
  init(){
    if(this.wired) return;
    this.wired = true;
    $('mmClose').addEventListener('click', () => this.close());
    $('mmBackdrop').addEventListener('click', e => { if(e.target === $('mmBackdrop')) this.close(); });
  },
  open(l){
    if(!l) return;
    this.init();
    this.cur = l; this.detail = null; this.fail = '';
    $('mmBackdrop').classList.add('open');
    const box = $('mmBackdrop').querySelector('.modal');
    if(box) box.scrollTop = 0;
    this.paint();
    this.startClock();
    this.load(l);
  },
  close(){
    $('mmBackdrop').classList.remove('open');
    this.stopClock();
    this.cur = null;
  },
  isOpen(){ return $('mmBackdrop').classList.contains('open'); },
  startClock(){ this.stopClock(); this.timer = setInterval(() => { this.paintCountdown(); this.paintTimelineState(); }, 1000); },
  stopClock(){ if(this.timer) clearInterval(this.timer); this.timer = null; },
  netMs(){
    const l = this.cur;
    if(!l || !l.dateObj) return null;
    const t = (l.dateObj instanceof Date ? l.dateObj : new Date(l.dateObj)).getTime();
    return isFinite(t) ? t : null;
  },
  /* Which side of T-0 are we on? window_end comes from the detail payload when it is
     available; without it, an hour past NET is treated as "in flight" rather than "closed". */
  phase(){
    const net = this.netMs();
    if(net == null) return { kind: 'unknown', sec: null };
    const d = this.detail || {};
    const end = d.window_end ? new Date(d.window_end).getTime() : null;
    const now = Date.now();
    if(now < net) return { kind: 'minus', sec: (net - now) / 1000 };
    if(end && now <= end) return { kind: 'plus', sec: (now - net) / 1000 };
    if(!end && now < net + 3600000) return { kind: 'plus', sec: (now - net) / 1000 };
    return { kind: 'closed', sec: (now - net) / 1000 };
  },
  async load(l){
    const id = l.launchId;
    this.loading = true;
    this.paint();
    if(!id){ this.loading = false; this.fail = 'no-id'; this.paint(); return; }
    if(this.memo[id]){ this.detail = this.memo[id]; this.loading = false; this.paint(); return; }
    const hit = ApiCache.get('ll2-launch:' + id);
    if(hit && hit.age < this.TTL){ this.detail = hit.data; this.memo[id] = hit.data; this.loading = false; this.paint(); return; }
    try{
      /* LL2's free tier is genuinely slow under load — a detail request has been measured
         hanging past 15 s and then answering in ~100 ms on the retry — so the timeout is set
         generously and the *failure* path stays useful rather than the wait being cut short. */
      const d = await httpJSON('https://ll.thespacedevs.com/2.2.0/launch/' + encodeURIComponent(id) + '/', { timeoutMs: 25000 });
      if(d && d.id){
        this.memo[id] = d;
        ApiCache.set('ll2-launch:' + id, d);
        this.detail = d;
        this.fail = '';
      } else {
        this.fail = 'empty';
      }
    }catch(e){
      this.fail = e && e.rateLimited ? 'throttled'
        : (e && e.timedOut ? 'timeout' : 'unreachable');
    }
    this.loading = false;
    if(this.cur && this.cur.launchId === id) this.paint();
  },
  /* the one number that has to look live */
  paintCountdown(){
    const el = $('mmCount');
    if(!el) return;
    const l = this.cur;
    if(!l) return;
    const st = String(l.statusAbbrev || '').toLowerCase();
    const p = this.phase();
    el.className = 't' + (p.kind === 'plus' ? ' tplus' : '');
    $('mmCountLbl').textContent = p.kind === 'plus' ? 'T-plus' : (st === 'hold' ? 'T-minus · hold' : 'T-minus');
    if(st === 'hold' && p.kind === 'minus'){
      el.className = 't hold';
      el.textContent = 'HOLD';
      $('mmCountLbl').textContent = 'countdown held';
      return;
    }
    if(p.kind === 'unknown'){ el.textContent = 'TBD'; return; }
    if(p.kind === 'closed'){ el.textContent = durLabel(-1 * p.sec); $('mmCountLbl').textContent = 'since NET'; return; }
    el.textContent = durLabel(p.kind === 'minus' ? -p.sec : p.sec);
  },
  async ensureGis(){ return null; },
  kv(k, v){
    return `<div class="mm-kv"><div class="k">${esc(k)}</div><div class="v">${v === '' || v == null ? '—' : v}</div></div>`;
  },
  paint(){
    const l = this.cur;
    if(!l) return;
    const d = this.detail || {};
    const m = d.mission || {};
    const cfg = (d.rocket && d.rocket.configuration) || {};
    $('mmStatus').className = 'badge ' + statusClass(l.statusAbbrev);
    $('mmStatus').textContent = l.statusName || '—';
    $('mmTitle').textContent = d.name || l.name;
    $('mmNet').textContent = 'NET ' + utcStamp(l.dateObj instanceof Date ? l.dateObj : new Date(l.dateObj))
      + (d.net_precision && d.net_precision.abbrev && d.net_precision.abbrev !== 'SEC' ? ' · ' + d.net_precision.abbrev + ' precision' : '');
    $('mmSub').textContent = [l.agency, l.rocket, l.pad].filter(Boolean).join(' · ');
    const win = (d.window_start && d.window_end)
      ? utcStamp(new Date(d.window_start)).slice(11) + ' – ' + utcStamp(new Date(d.window_end)).slice(11)
      : (l.windowLabel || 'instantaneous (or not published)');
    $('mmWindow').textContent = win;
    $('mmSync').textContent = d.last_updated ? 'manifest updated ' + utcStamp(new Date(d.last_updated)) : 'manifest row';
    this.paintCountdown();
    /* what went wrong with the enrichment — stated, never hidden */
    const n = $('mmNotice');
    if(this.loading && !this.detail){
      n.innerHTML = '<div class="notice ok"><span class="n-ico">⏳</span><div><b>Fetching the full manifest entry…</b>'
        + '<span class="n-sub">Launch Library files the mission summary, the stage record and the countdown sequence under a second request. Everything in the tiles above is already live from the manifest row.</span></div></div>';
      n.hidden = false;
    } else if(this.fail){
      const why = this.fail === 'throttled'
        ? 'Launch Library is throttling detail requests right now (its free tier allows only a few per hour).'
        : this.fail === 'timeout' ? 'The detail request timed out.'
        : this.fail === 'no-id' ? 'This manifest row arrived without a detail id.'
        : 'The detail request could not be completed.';
      n.innerHTML = `<div class="notice"><span class="n-ico">ℹ</span><div><b>${esc(why)}</b> The dossier below is built from the manifest row, so the mission summary, stage breakdown and countdown sequence are missing until that request succeeds.`
        + `<span class="n-sub">The T-minus clock and every row value are still real — they come from the manifest's own NET and status.</span>`
        + `<div class="n-actions">${Retry.btn('mmdetail', '↻ retry the detail request')}</div></div></div>`;
      Retry.register('mmdetail', () => { if(this.cur){ this.fail = ''; this.load(this.cur); } });
      n.hidden = false;
    } else { n.hidden = true; n.innerHTML = ''; }
    /* The payload leads: "what is going up" is the question a manifest row is clicked to
       answer, and its type and target orbit sit beside it so the field describes the cargo
       rather than naming it and leaving the reader to infer the rest. */
    $('mmGrid').innerHTML = [
      this.kv('Payload', esc(this.payloadName(d, m))),
      this.kv('Payload type', esc((m.type || 'not published') + (m.orbit && m.orbit.abbrev && m.orbit.abbrev !== 'N/A' ? ' · ' + m.orbit.abbrev : ''))),
      this.kv('Provider', esc(l.agency)),
      liveKv(l),
      this.kv('Vehicle', esc(cfg.full_name || l.rocket)),
      this.kv('Launch site', esc(l.pad || 'not published')),
      this.kv('Probability', d.probability != null ? fmt(d.probability, 0) + '%' : 'not published'),
      this.kv('Weather', d.weather_concerns ? esc(String(d.weather_concerns).slice(0, 180)) : 'no concerns published'),
      this.kv('Orbit', m.orbit && m.orbit.name ? esc(m.orbit.name) : '—'),
    ].join('');
    /* the vehicle picture: the API's own photograph when the configuration publishes one, the
       themed placeholder when it does not — never an empty frame */
    const rocket = this.rocketHtml(cfg, l);
    $('mmRocket').innerHTML = rocket;
    $('mmRocket').hidden = !rocket;
    $('mmPayload').innerHTML = this.payloadHtml(d, m);
    $('mmStages').innerHTML = this.stagesHtml(d, cfg);
    $('mmTimeline').innerHTML = this.timelineHtml(d);
    this.paintJellyfish(l);
    $('mmActions').innerHTML = this.actionsHtml(d, m, l);
    $('mmNote').innerHTML = 'Manifest and detail data from <a href="https://thespacedevs.com/llapi" target="_blank" rel="noopener noreferrer">The Space Devs · Launch Library 2</a>. '
      + 'Countdown offsets are the publisher\u2019s own sequence, converted from ISO-8601 durations.';
  },
  /* The payload's own designation. LL2 hangs it on `mission.name`, but files it as "Unknown
     Payload" often enough that those rows fall back to the tail of the launch name — the part
     after the provider's `|` separator. */
  payloadName(d, m){
    if(m && m.name && m.name !== 'Unknown Payload') return m.name;
    if(this.cur && this.cur.payload) return this.cur.payload;
    const full = String((d && d.name) || '');
    const tail = full.split('|').pop().trim();
    return (tail && tail !== full && !/^unknown payload$/i.test(tail)) ? tail : 'not published';
  },
  /* The vehicle picture, with its source named underneath: an honest caption matters here,
     because a placeholder that looked photographic would misrepresent the record. */
  rocketHtml(cfg, l){
    const real = !!(cfg && cfg.image_url && /^https?:\/\//i.test(cfg.image_url));
    const name = (cfg && (cfg.full_name || cfg.name)) || (l && l.rocket) || 'the vehicle';
    const src = real ? esc(cfg.image_url) : ROCKET_ART.ph((cfg && (cfg.family || cfg.full_name || cfg.name)) || (l && l.rocket));
    return `<img src="${src}" alt="${esc(name)}" loading="lazy" />`
      + `<div class="cap"><span>${esc(name)}</span><span class="tag">${real ? 'photograph · Launch Library 2' : 'no published photograph — placeholder'}</span></div>`;
  },
  payloadHtml(d, m){
    /* one reader for the payload's name, shared with the grid tile, so the dossier cannot say
       two different things about the same cargo */
    const label = this.payloadName(d, m);
    const name = label === 'not published' ? '' : label;
    const bits = [];
    if(name) bits.push(`<b>${esc(name)}</b>`);
    if(m.type) bits.push(esc(m.type));
    if(m.orbit && m.orbit.name) bits.push('to ' + esc(m.orbit.name));
    const agencies = (m.agencies || []).map(a => a && a.name).filter(Boolean);
    let out = `<p class="mm-text">${bits.join(' · ') || 'The payload for this flight has not been published yet.'}</p>`;
    if(m.description) out += `<p class="mm-text" style="margin-top:10px">${esc(String(m.description).slice(0, 1400))}</p>`;
    else out += `<p class="mm-text" style="margin-top:10px;color:var(--text-3)">No objective text has been published for this mission — Launch Library files it as <span class="mono">${esc(m.name || 'unnamed')}</span>, and mission descriptions usually appear a few days before liftoff.</p>`;
    if(agencies.length) out += `<p class="mm-text" style="margin-top:10px">Customer${agencies.length > 1 ? 's' : ''}: <b>${esc(agencies.join(', '))}</b></p>`;
    return out;
  },
  /* Stage rows come from `launcher_stage` when the publisher has filled them in (SpaceX
     flights carry the booster serial, flight number and landing plan). Rocket Lab, CASC and
     most others leave the array empty, so the breakdown falls back to the vehicle envelope
     that is always present — and says which of the two it is showing. */
  stagesHtml(d, cfg){
    const stages = Array.isArray(d.rocket && d.rocket.launcher_stage) ? d.rocket.launcher_stage : [];
    let out = '';
    if(stages.length){
      out += stages.map((s, i) => {
        const type = String(s.type || (i === 0 ? 'Core' : 'Stage ' + (i + 1)));
        const cls = /core|first|1\b/i.test(type) ? 'core' : (/upper|second|2\b/i.test(type) ? 'upper' : (/fairing|payload|nose/i.test(type) ? 'fairing' : ''));
        const lch = s.launcher || {};
        const facts = [];
        if(lch.serial_number) facts.push('booster ' + lch.serial_number);
        if(s.launcher_flight_number != null) facts.push('flight #' + s.launcher_flight_number);
        if(lch.flights != null) facts.push(lch.flights + ' flights logged');
        if(s.reused === true) facts.push('flight-proven airframe');
        if(s.reused === false) facts.push('new airframe');
        const land = s.landing || null;
        const flag = land && land.attempt
          ? 'landing: ' + ((land.type && land.type.abbrev) || 'planned')
            + (land.location && land.location.name ? ' · ' + land.location.name : '')
            + (num(land.downrange_distance) != null ? ' · ' + fmt(land.downrange_distance, 0) + ' km downrange' : '')
            + (land.success === true ? ' · recovered' : land.success === false ? ' · failed' : '')
          : (land && land.attempt === false ? 'expendable — no landing attempt' : 'landing not published');
        return `<div class="mm-stage">
            <span class="st-tag ${cls}">${esc(type)}</span>
            <div>
              <div class="st-t">${esc(s.reused ? 'Reused stage · ' + type : type)}</div>
              <div class="st-s">${esc(facts.join(' · ') || 'no airframe detail published')}</div>
            </div>
            <span class="st-flag ${s.reused ? 'reused' : ''}">${esc(flag)}</span>
          </div>`;
      }).join('');
    } else {
      out += `<div class="mm-stage">
          <span class="st-tag">stages</span>
          <div><div class="st-t">${cfg.min_stage != null ? (cfg.min_stage === cfg.max_stage ? cfg.min_stage : cfg.min_stage + '–' + cfg.max_stage) : '—'} stage${cfg.max_stage === 1 ? '' : 's'}</div>
          <div class="st-s">${esc(cfg.family || cfg.full_name || 'vehicle')}${cfg.reusable ? ' · partially reusable' : ' · expendable'}</div></div>
          <span class="st-flag">from the vehicle record</span>
        </div>`;
    }
    /* Always-present envelope numbers, labelled as the vehicle data they are */
    out += '<div class="mm-grid" style="margin-top:12px">'
      + this.kv('Vehicle length', num(cfg.length) != null ? fmt(cfg.length, 1) + ' m' : '—')
      + this.kv('Diameter', num(cfg.diameter) != null ? fmt(cfg.diameter, 2) + ' m' : '—')
      + this.kv('Liftoff thrust', num(cfg.to_thrust) != null ? fmt(cfg.to_thrust, 0) + ' kN' : '—')
      + this.kv('Capacity', (num(cfg.leo_capacity) != null ? fmt(cfg.leo_capacity, 0) + ' kg LEO' : '—')
          + (num(cfg.gto_capacity) != null ? ' · ' + fmt(cfg.gto_capacity, 0) + ' kg GTO' : ''))
      + '</div>';
    out += `<p class="mm-text" style="margin-top:10px;color:var(--text-3);font-size:11.5px">`
      + (stages.length
        ? 'Stage detail above is the publisher\u2019s own record for this flight.'
        : 'This launch has no per-stage record in Launch Library — the rows below the summary are the launcher\u2019s published envelope.')
      + ' Launch Library does not model a fairing as its own object; the fairing envelope is the vehicle diameter above, not a separate published figure.</p>';
    return out;
  },
  timelineHtml(d){
    const tl = Array.isArray(d.timeline) ? d.timeline : [];
    if(!tl.length){
      return '<p class="mm-text">No countdown sequence has been published for this flight yet. Launch Library usually files it in the last few days before liftoff; the T-minus clock above is computed from the NET either way.</p>';
    }
    const net = this.netMs();
    const now = Date.now();
    const rows = tl.map(t => {
      const off = isoDur(t.relative_time);
      if(off == null) return null;
      const type = t.type || {};
      const at = net != null ? net + off * 1000 : null;
      return { off: off, label: type.abbrev || '', desc: type.description || '', at: at, done: at != null && now >= at };
    }).filter(Boolean).sort((a, b) => a.off - b.off);
    if(!rows.length) return '<p class="mm-text">The published sequence could not be read.</p>';
    const upcoming = rows.filter(r => !r.done)[0] || null;
    const head = upcoming
      ? `<p class="mm-text" style="margin-bottom:10px">Next up: <b>${esc(upcoming.label)}</b> at <span class="mono">${esc(durLabel(upcoming.off))}</span> — ${esc(upcoming.desc)}</p>`
      : '<p class="mm-text" style="margin-bottom:10px">Every published step has been passed.</p>';
    return head + '<div class="mm-tl">' + rows.map(r =>
      `<div class="tl-row${r.done ? ' done' : ''}"><span class="t">${esc(durLabel(r.off))}</span>`
      + `<span class="d"><b>${esc(r.label)}</b>${esc(r.desc)}</span></div>`).join('') + '</div>';
  },
  paintTimelineState(){
    const host = $('mmTimeline');
    if(!host || !this.detail) return;
    /* re-render at most once a minute — this runs on the 1 s countdown tick */
    const now = Math.floor(Date.now() / 60000);
    if(this._tlMin === now) return;
    this._tlMin = now;
    host.innerHTML = this.timelineHtml(this.detail);
  },
  /* The dossier's own space-jellyfish section, at the bottom of every launch. It reuses the
     Jellyfish watch's geometry (pad sun elevation, the shared observer, distance/bearing/sightline)
     so the dossier and the Space Jellyfish page can never disagree about the same launch. */
  paintJellyfish(l){
    const host = $('mmJellyfish');
    if(!host) return;
    let html = '';
    try{
      const jf = (typeof Jellyfish !== 'undefined') ? Jellyfish : null;
      const t = l.dateObj instanceof Date ? l.dateObj.getTime() : NaN;
      const el = (jf && isFinite(t) && l.padLat != null && l.padLon != null)
        ? jf.sunElev(t, l.padLat, l.padLon) : null;
      const b = jf ? jf.band(el) : { label: 'sun position unknown', cls: '', why: '' };
      const o = jf ? jf.obs() : null;
      const v = (jf && o) ? jf.outlook({ l: l, t: t, el: el, b: b }, o) : null;
      const tag = `<span class="jf-tag${b.cls ? ' ' + b.cls : ''}">${esc(b.label)}${el != null ? ' · sun ' + (el >= 0 ? '+' : '') + fmt(el, 1) + '° at the pad' : ''}</span>`;
      if(!jf || el == null){
        html = `<div class="mm-jf"><div class="jf-tag">space jellyfish · cannot tell</div>`
          + `<div class="jf-line">this launch carries no pad coordinates, so the solar geometry cannot be worked out.</div></div>`;
      } else if(v){
        const dTxt = v.d == null ? '' : (v.d < 2 ? 'you are at the pad itself'
          : `the pad is <b>${fmt(v.d, 0)} km</b> away on a bearing of <b>${jf.compass(v.brg)}</b> (${fmt(v.brg, 0)}°)`);
        const sightTxt = v.pe != null && v.pe > 0 ? `, the plume would ride about <b>${fmt(v.pe, 0)}°</b> above your horizon` : '';
        const yourTxt = o ? ` — judged from your viewpoint (${o.lat.toFixed(4)}, ${o.lon.toFixed(4)})` : '';
        html = `<div class="mm-jf"><div class="jf-line">${tag}${yourTxt}</div>`
          + `<div class="jf-line">🐝 <b>${esc(v.label)}</b>${dTxt ? ' — ' + dTxt : ''}${sightTxt}. ${esc(v.why)}</div>`
          + `<div class="jf-line"><a href="#" class="jf-open-link" data-jf-open="1">open the Space Jellyfish page ↗</a> — search any place, or stand at one of the manifest's pads</div></div>`;
      } else {
        html = `<div class="mm-jf"><div class="jf-line">${tag}</div>`
          + `<div class="jf-line">🐝 the pad can catch the light (its sun elevation is ${fmt(el, 1)}°), but no viewpoint is set — enter coordinates on the <a href="#" class="jf-open-link" data-jf-open="1">Space Jellyfish page</a> to judge it from anywhere</div></div>`;
      }
    }catch(e){ html = ''; }
    host.innerHTML = html;
    host.hidden = !html;
  },

  actionsHtml(d, m, l){
    const out = [];
    const vids = Array.isArray(d.vidURLs) ? d.vidURLs : [];
    vids.slice(0, 1).forEach(v => {
      if(v && v.url) out.push(`<a class="btn" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">official feed · ${esc(v.source || 'source')} ↗</a>`);
    });
    const infos = (Array.isArray(d.infoURLs) ? d.infoURLs : []).concat((m && Array.isArray(m.info_urls)) ? m.info_urls : []);
    infos.slice(0, 3).forEach(u => {
      if(u && u.url) out.push(`<a class="btn" href="${esc(u.url)}" target="_blank" rel="noopener noreferrer">${esc(u.description || u.title || 'mission notes')} ↗</a>`);
    });
    if(d.url) out.push(`<a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">full record ↗</a>`);
    const host = $('mmActions');
    if(host){
      host.innerHTML = out.join('');
    }
    return out.join('');
  }
};

export { MissionModal };

export function utcStampPublic(d){ return utcStamp(d); }
