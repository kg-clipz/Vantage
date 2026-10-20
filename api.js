/* ================================================================
   Vantage — js/api.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */

/* ================================================================
   Vantage — mission console
   ================================================================ */
const $ = id => document.getElementById(id);

/* ---------------- safe storage (private-mode / security-exception tolerant) ----------------
   Falls back to an in-memory map when localStorage throws (Safari private mode,
   blocked cookies, embedded webviews). Data simply won't persist across reloads. */
const Store = {
  ok: (() => { try{ localStorage.setItem('__vantage_probe','1'); localStorage.removeItem('__vantage_probe'); return true; }catch(e){ return false; } })(),
  mem: {},
  get(k, fallback){
    if(this.ok){ try{ const v = localStorage.getItem(k); if(v !== null) return v; }catch(e){} }
    return Object.prototype.hasOwnProperty.call(this.mem, k) ? this.mem[k] : fallback;
  },
  set(k, v){
    this.mem[k] = String(v);
    if(this.ok){ try{ localStorage.setItem(k, String(v)); }catch(e){} }
  },
  getJSON(k, fallback){
    const raw = this.get(k, null);
    if(raw === null) return fallback;
    try{ return JSON.parse(raw); }catch(e){ return fallback; }
  },
  setJSON(k, v){ this.set(k, JSON.stringify(v)); }
};

/* ---------------- response cache for the key-less feeds ----------------
   EONET and NOAA SWPC are public services we do not own: they throttle, and they go down.
   A stored copy keeps the view populated through either, and the UI always says which one it
   is showing. Everything routes through Store, so private mode silently degrades to the
   in-memory map instead of throwing. Records larger than the quota guard are skipped rather
   than risking a QuotaExceededError on a neighbouring key. */
const ApiCache = {
  PREFIX: 'vantage-cache:',
  MAX_BYTES: 1400000,
  get(key){
    const rec = Store.getJSON(this.PREFIX + key, null);
    if(!rec || typeof rec !== 'object' || !rec.t || !('data' in rec)) return null;
    return { data: rec.data, at: rec.t, age: Date.now() - rec.t };
  },
  set(key, data){
    try{
      const raw = JSON.stringify({ t: Date.now(), data: data });
      if(raw.length > this.MAX_BYTES) return false;
      Store.set(this.PREFIX + key, raw);
      return true;
    }catch(e){ return false; }
  }
};

/* ---------------- key-less third-party fetch ----------------
   Same timeout discipline as nasaFetch — a hanging request must never leave the UI reading
   "fetching" forever — but without api.nasa.gov's rate-limit classification, because a 429
   from a non-NASA host is not a problem an api.nasa.gov key can fix. */
async function httpJSON(url, { timeoutMs = 15000 } = {}){
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try{
    res = await fetch(url, { signal: ctrl.signal });
  }catch(e){
    const err = new Error(e && e.name === 'AbortError' ? 'request timed out' : 'network unreachable');
    err.network = true;
    err.timedOut = !!(e && e.name === 'AbortError');
    throw err;
  }finally{
    clearTimeout(killer);
  }
  if(!res.ok){
    const err = new Error(res.status === 429 ? 'provider rate limit' : 'HTTP ' + res.status);
    err.httpStatus = res.status;
    err.rateLimited = res.status === 429 || res.status === 503;
    throw err;
  }
  try{ return await res.json(); }
  catch(e){
    const err = new Error('invalid JSON');
    err.httpStatus = res.status;
    throw err;
  }
}

let NASA_KEY = Store.get('vantage-nasa-key', 'DEMO_KEY');
const pad = n => n.toString().padStart(2, '0');
const isoDate = d => d.toISOString().slice(0, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n, d = 1) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
/* Finite-number handling. API fields legitimately go missing, and "NaN LD" in a table is
   worse than an honest dash, so every feed value is parsed through num() first. */
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const fmtv = (n, d = 1) => Number.isFinite(n) ? fmt(n, d) : '—';

let todayIso = isoDate(new Date());

/* ---------------- rate-limit watcher + NASA fetch wrapper ---------------- */
const RateLimit = {
  active: false,
  show(source){
    if(this.active) return;
    this.active = true;
    $('rl-source').textContent = source ? `(${source})` : '';
    $('rl-banner').classList.add('show');
  },
  hide(){
    this.active = false;
    $('rl-banner').classList.remove('show');
  }
};
/* stale-response guard — rapid range/date changes fire overlapping requests, and a slow
   older response can land *after* a newer one and desynchronise the UI. Every loader takes
   a token at request start and drops its result if a newer generation has already begun. */
const Seq = {
  _n: {},
  next(tag){ this._n[tag] = (this._n[tag] || 0) + 1; return this._n[tag]; },
  current(tag){ return this._n[tag] || 0; },
  isStale(tag, token){ return this._n[tag] !== token; }
};

/* manual retries — error cards carry their own button so a failed feed never forces a
   page reload */
const Retry = {
  _fns: {},
  /* loaders that degrade to sample data still need a way back to the live feed, so the
     button markup and its handler can be attached to any status line, not only a card */
  register(tag, fn){ if(typeof fn === 'function') this._fns[tag] = fn; return this; },
  btn(tag, label){ return `<button class="retry-btn" data-retry="${tag}">${label || 'retry now'}</button>`; },
  card(msg, tag, fn){
    if(typeof fn === 'function') this._fns[tag] = fn;
    return `<div class="err">${msg} ${this.btn(tag)}</div>`;
  }
};
/* the aurora note is rebuilt on every paint, so its action is delegated rather than bound */
document.addEventListener('click', e => {
  const frame = e.target && e.target.closest ? e.target.closest('[data-aurora-frame]') : null;
  if(frame){ Aurora.frame(); }
});
document.addEventListener('click', e => {
  const btn = e.target && e.target.closest ? e.target.closest('[data-retry]') : null;
  if(!btn) return;
  const fn = Retry._fns[btn.dataset.retry];
  if(typeof fn !== 'function') return;
  btn.disabled = true; btn.textContent = 'retrying…';
  fn();
  setTimeout(() => { btn.disabled = false; btn.textContent = 'retry now'; }, 2500);
});

/* A placeholder still on screen seconds later is a failure the viewer can see but cannot
   act on, so it is replaced by the standard retry card. Only a placeholder whose markup has
   not changed *at all* is converted: a loader that already swapped in live data, sample data
   or its own error state leaves a different innerHTML, and is left well alone. */
const Skeleton = {
  TIMEOUT: 5000,
  _jobs: {},
  watch(tag, id, retry, msg, wrap){
    const el = $(id);
    if(!el || !/loading/.test(el.innerHTML)) return;   // not a skeleton — nothing to guard
    el.querySelectorAll('.loading').forEach(n => n.classList.add('sk'));
    if(el.classList.contains('loading')) el.classList.add('sk');
    const placeholder = el.innerHTML;
    clearTimeout(this._jobs[tag]);
    this._jobs[tag] = setTimeout(() => {
      const still = $(id);
      if(!still || still.innerHTML !== placeholder) return;   // the loader took over in time
      const card = Retry.card(msg || 'This feed is taking longer than expected.', tag, retry);
      still.innerHTML = typeof wrap === 'function' ? wrap(card) : card;
    }, this.TIMEOUT);
  },
  /* a loader that owns the element calls this so a long-but-healthy fetch — the Mars raw
     feed routinely takes 20 s — can never be converted out from under it */
  settle(tag){ clearTimeout(this._jobs[tag]); }
};
function debounce(fn, ms){
  let h = null;
  return function(...args){ clearTimeout(h); h = setTimeout(() => fn.apply(this, args), ms); };
}

async function nasaFetch(url, { label = 'NASA API', timeoutMs = 10000 } = {}){
  // hanging requests must never freeze the UI on "fetching" — abort and surface the error
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try{
    res = await fetch(url, { signal: ctrl.signal });
  }catch(e){
    const err = new Error(e && e.name === 'AbortError' ? 'request timed out' : 'network unreachable');
    err.network = true;
    if(e && e.name === 'AbortError') err.timedOut = true;
    throw err;
  }finally{
    clearTimeout(killer);
  }
  // api.nasa.gov reports a throttle through the *body*, not only the status: the Mars paths
  // answer HTTP 404 (not 429) with {"error":{"code":"OVER_RATE_LIMIT"}}, and 200s can carry
  // an error envelope too. Read the body once, then classify it before trusting the status.
  let raw = '', data = null;
  try{ raw = await res.text(); }catch(_e){ raw = ''; }
  try{ data = raw ? JSON.parse(raw) : null; }catch(_e){ data = null; }
  const envelope = (data && typeof data === 'object' && data.error) ? data.error : null;
  const codeStr = envelope ? String(envelope.code || '').toUpperCase() : '';
  const envMsg = envelope ? String((envelope.message || '') + ' ' + (envelope.code || '')).toLowerCase() : '';
  const throttled = !!envelope && (codeStr === 'OVER_RATE_LIMIT'
    || envMsg.includes('rate limit') || envMsg.includes('over_rate') || envMsg.includes('over rate')
    || envMsg.includes('quota') || envMsg.includes('too many requests'));
  if(res.status === 429 || res.status === 402 || throttled){
    const err = new Error('NASA API rate limit');
    err.rateLimited = true; err.httpStatus = res.status;
    RateLimit.show(label);
    throw err;
  }
  if(!res.ok){
    const err = new Error(envelope && envelope.message ? envelope.message : 'HTTP ' + res.status);
    err.httpStatus = res.status; err.apiError = envelope || null;
    throw err;
  }
  if(data === null){
    const err = new Error('invalid JSON');
    err.httpStatus = res.status;
    throw err;
  }
  if(envelope){
    const err = new Error(envelope.message || 'API error');
    err.apiError = envelope; err.httpStatus = res.status;
    throw err;
  }
  // only an api.nasa.gov success proves the *key* throttle has cleared — a key-less host
  // (EPIC, the image library) succeeding must not flicker the banner off
  if(RateLimit.active && url.indexOf('api.nasa.gov') !== -1) RateLimit.hide();
  return data;
}

/* staggered request queue — DEMO_KEY allows ~30 req/hr shared across ALL callers;
   firing every section at once burns it in a burst. Serialize NASA calls with a
   deliberate gap when on the demo key. */
let keyQueue = Promise.resolve();
function staggeredNasaFetch(url, opts){
  const gap = NASA_KEY === 'DEMO_KEY' ? 900 : 0;
  const run = () => nasaFetch(url, opts);
  const p = keyQueue.then(run, run);
  keyQueue = p.catch(() => {});
  return p;
}
const SampleData = {
  badge(text = 'sample'){ return `<span class="sample-badge" title="Offline data — the live feed is unreachable or rate-limited">${text}</span>`; },
  /* key-less, CORS-open NASA raw-images feed — REAL Curiosity/Perseverance imagery
     that works even when api.nasa.gov is throttled. msl = Curiosity (needs an explicit
     sol), mars2020 = Perseverance (serves the latest sol when no sol given). */
  RAW_IMAGES: {
    Curiosity:    { category: 'msl' },
    Perseverance: { category: 'mars2020' }
  },
  rawInstrument(im){
    return String((im && (im.instrument || im.camera) || (im && im.extended && (im.extended.instrument || im.extended.instrument_type)) || '')).toUpperCase();
  },
  rawUrl(rover, sol){
    const cfg = this.RAW_IMAGES[rover];
    if(!cfg) return null;
    const solPart = (rover === 'Curiosity' && sol != null) ? `&sol=${sol}` : '';
    return `https://mars.nasa.gov/rss/api/?feed=raw_images&category=${cfg.category}&feedtype=json&num=24&page=0${solPart}`;
  },
  /* mars.nasa.gov serves raw rover frames with NO key and no shared quota, which keeps this
     grid alive while api.nasa.gov is throttled. Two quirks: it is slow (10–25 s, hence the
     long timeout) and Curiosity's `msl` category answers "No more images" unless an explicit
     sol is given — so step back until frames actually appear. */
  async rawRoverImages(rover, solFilter, onProgress){
    if(!this.RAW_IMAGES[rover]) return null;
    const sols = [null];
    if(rover === 'Curiosity'){
      const start = Number(solFilter) || currentSol(rover) || 5000;
      sols.length = 0;
      for(let i = 0; i < 4; i++) sols.push(Math.max(0, start - i));
    }
    for(const sol of sols){
      const d = await nasaFetch(this.rawUrl(rover, sol), { label: 'NASA Raw Images', timeoutMs: 35000 });
      const list = ((d && d.images) || []).filter(im => im && im.image_files && (im.image_files.medium || im.image_files.small));
      if(list.length) return { images: list, sol: sol, requestedSol: Number(solFilter) || null };
      if(onProgress && sol != null) onProgress(`sol ${sol} has no downlinked frames — stepping back…`);
    }
    return null;
  },
  launches(){
    // realistic representative manifest — shown only while the live feed is throttled/unreachable
    const H = 3600e3; // one hour in ms
    const mk = (name, hrs, agency, rocket, pad, loc, abbrev, statusName) => ({
      name, agency, rocket, pad: pad + ' · ' + loc,
      statusAbbrev: abbrev, statusName,
      dateObj: new Date(Date.now() + hrs * H)
    });
    return [
      mk('Falcon 9 | Starlink 11-4', 14, 'SpaceX', 'Falcon 9 Block 5', 'LC-39A', 'Kennedy Space Center, FL, USA', 'Go', 'Go for launch'),
      mk('Electron | Owl New Constellation-3', 39, 'Rocket Lab', 'Electron', 'LC-1A', 'Māhia Peninsula, New Zealand', 'Go', 'Go for launch'),
      mk('Falcon 9 | Transporter-15', 2 * 24 + 6, 'SpaceX', 'Falcon 9 Block 5', 'SLC-4E', 'Vandenberg SFB, CA, USA', 'TBC', 'To be confirmed'),
      mk('Ariane 6 | VA-04 MetOp-SG', 3 * 24 + 2, 'Arianespace', 'Ariane 64', 'ELA-4', 'Guiana Space Centre, French Guiana', 'TBD', 'To be determined'),
      mk('Vulcan | Cert-2 Dream Chaser', 4 * 24 + 9, 'United Launch Alliance', 'Vulcan VC4', 'SLC-41', 'Cape Canaveral SFS, FL, USA', 'TBD', 'To be determined'),
      mk('GSLV Mk III | NISAR', 5 * 24 + 5, 'ISRO', 'GSLV Mk III', 'LP-2', 'Satish Dhawan Space Centre, India', 'Go', 'Go for launch'),
      mk('Long March 5B | CSL-3 Module', 6 * 24 + 12, 'CASC', 'Long March 5B', 'LC-101', 'Wenchang, China', 'TBD', 'To be determined'),
      mk('Soyuz-2.1b | GLONASS K2-14', 7 * 24 + 3, 'Russian Space Forces', 'Soyuz-2.1b', 'PU-43', 'Plesetsk Cosmodrome, Russia', 'TBC', 'To be confirmed'),
      mk('New Shepard | NS-31 Research', 8 * 24 + 7, 'Blue Origin', 'New Shepard', 'LS-WC', 'West Texas, USA', 'TBD', 'To be determined'),
      mk('H3 | ALOS-4 Follow-on', 9 * 24 + 1, 'JAXA', 'H3-22', 'LA-Y', 'Tanegashima Space Center, Japan', 'Go', 'Go for launch')
    ].map(l => ({ ...l,
      /* the sample manifest names its payload in the launch string ("Falcon 9 | Starlink 11-4"),
         so the payload field and the placeholder picture are demonstrable here too rather than
         appearing only when the live feed answers */
      payload: (l.name.split('|').pop() || '').trim(),
      rocketImage: '', rocketFamily: l.rocket,
      dateDisplay: l.dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      timeDisplay: l.dateObj.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }));
  },
  apod(dateStr){
    const picks = [
      { title: 'Orion over the Bay of Storms (sample)', explanation: 'This is built-in sample content: the live NASA APOD feed could not be reached because the API rate limit was hit. Add a personal api.nasa.gov key via the sidebar to restore real astronomy pictures — the rest of the console keeps working meanwhile.', url: 'https://picsum.photos/seed/vantage-orion/1200/800', hdurl: 'https://picsum.photos/seed/vantage-orion/1600/1000', media_type: 'image', copyright: 'Sample imagery' },
      { title: 'Dust lanes of the Great Rift (sample)', explanation: 'Built-in sample entry shown while the APOD feed is rate-limited. Text and imagery are placeholders that keep the layout intact; every control still works. A free personal key restores the live feed instantly.', url: 'https://picsum.photos/seed/vantage-rift/1200/800', hdurl: 'https://picsum.photos/seed/vantage-rift/1600/1000', media_type: 'image', copyright: 'Sample imagery' },
      { title: 'Aurora australis from low orbit (sample)', explanation: 'This placeholder keeps the Sky & Earth view functional when api.nasa.gov is throttled. Sample data is clearly badged — imagery and text are synthetic, clearly labelled, and replaced by live data as soon as a key is added.', url: 'https://picsum.photos/seed/vantage-aurora/1200/800', hdurl: 'https://picsum.photos/seed/vantage-aurora/1600/1000', media_type: 'image', copyright: 'Sample imagery' }
    ];
    const h = String(dateStr).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return Object.assign({}, picks[h % picks.length], { date: dateStr, sample: true });
  },
  epic(){
    const now = Date.now();
    return Array.from({ length: 8 }, (_, i) => ({
      date: new Date(now - i * 2 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '),
      image: 'sample-' + i,
      caption: 'Sample frame — live EPIC feed rate-limited'
    }));
  },
  epicUrl(seed, large){
    return `https://picsum.photos/seed/vantage-epic-${seed}/${large ? '1200/800' : '400/400'}`;
  },
  neo(startIso, endIso){
    const start = new Date(startIso + 'T00:00:00Z').getTime();
    const span = Math.max(86400000, new Date(endIso + 'T00:00:00Z').getTime() - start);
    const mk = (name, dayFrac, missLunar, vel, diam, hazardous, mag) => ({
      name, hazardous,
      date: isoDate(new Date(start + span * dayFrac)),
      missLunar, missKm: missLunar * 384400, vel, diam, mag
    });
    return [
      mk('(2019 VB5)', 0.12, 1.24, 6.11, 148, true, 21.2),
      mk('433 Eros', 0.25, 14.7, 17.02, 16800, false, 10.5),
      mk('(2026 RP1)', 0.38, 3.05, 9.44, 62, false, 24.0),
      mk('99942 Apophis', 0.50, 9.81, 12.61, 340, true, 19.7),
      mk('(2021 EU)', 0.62, 0.86, 21.35, 24, false, 26.3),
      mk('(2010 PK9)', 0.74, 22.4, 5.02, 410, false, 19.1),
      mk('(2023 HM)', 0.86, 6.53, 14.18, 96, false, 22.6),
      mk('1566 Icarus', 0.95, 18.2, 25.90, 1400, false, 16.9)
    ];
  },
  marsManifest(rover){
    return String(rover).toLowerCase() === 'curiosity'
      ? { name: 'Curiosity', launch_date: '2011-11-26', landing_date: '2012-08-06', max_sol: 4702, total_photos: 1327984, status: 'active', sample: true, photos: [{ sol: 4702, total_photos: 214 }, { sol: 4701, total_photos: 96 }, { sol: 4700, total_photos: 132 }] }
      : { name: 'Perseverance', launch_date: '2020-07-30', landing_date: '2021-02-18', max_sol: 2704, total_photos: 912340, status: 'active', sample: true, photos: [{ sol: 2704, total_photos: 187 }, { sol: 2703, total_photos: 74 }, { sol: 2702, total_photos: 121 }] };
  },
  marsPhotos(rover, solOrDate){
    const isC = String(rover).toLowerCase() === 'curiosity';
    const cams = isC
      ? ['MAST', 'MAST', 'CHEMCAM', 'MAHLI', 'NAVCAM', 'FHAZ', 'RHAZ', 'MAST']
      : ['MCZ_RIGHT', 'NAVCAM_LEFT', 'SHERLOC_WATSON', 'SUPERCAM_RMI', 'MCZ_LEFT', 'FRONT_HAZCAM_LEFT_A', 'NAVCAM_RIGHT', 'MCZ_RIGHT'];
    const sol = /^\d+$/.test(String(solOrDate)) ? Number(solOrDate) : 4700;
    const earth = isoDate(new Date());
    return cams.map((c, i) => ({
      id: 100000 + i, sol, earth_date: earth,
      img_src: `https://picsum.photos/seed/vantage-mars-${sol}-${i}/400/400`,
      camera: { name: c, full_name: c },
      rover: { name: isC ? 'Curiosity' : 'Perseverance' }
    }));
  }
};

export { $, Store, ApiCache, httpJSON, nasaFetch, staggeredNasaFetch, pad, isoDate, esc, fmt, fmtv, num,
         todayIso, RateLimit, Seq, Retry, Skeleton, debounce, SampleData };

/* the demo key is shared across every NASA module; app.js mutates it through these */
export function getNasaKey(){ return NASA_KEY; }
export function setNasaKey(k){ NASA_KEY = (k && k.trim()) || 'DEMO_KEY'; }
