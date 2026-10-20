import { openModal } from '../ui.js';
/* ================================================================
   Vantage — js/modules/rovers.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */
import { $, Store, httpJSON, esc, fmt, num, isoDate, todayIso, debounce, nasaFetch, staggeredNasaFetch, Seq, SampleData } from '../api.js';
import { Charts } from './charts.js';
/* ================================================================
   Mars rovers
   ================================================================ */
const ROVERS = {
  Curiosity:     { name: 'Curiosity',     cameras: ['FHAZ','RHAZ','MAST','CHEMCAM','MAHLI','MARDI','NAVCAM'] },
  Perseverance:  { name: 'Perseverance',  cameras: ['NAVCAM','MCZ','FRONT_HAZCAM','REAR_HAZCAM','SHERLOC','SUPERCAM','SKYCAM','LCAM'] }
};
/* static mission facts (launch/landing/site never change, so they are safe to hold locally)
   plus the sol clock: sol ≈ Earth days since landing ÷ 1.02749125. This replaces the manifest
   service for date bounds and tells us which sol to *ask* the raw feed for. */
const ROVER_META = {
  Curiosity:    { launch: '2011-11-26', landing: '2012-08-06', site: 'Gale Crater',   solLen: 1.02749125 },
  Perseverance: { launch: '2020-07-30', landing: '2021-02-18', site: 'Jezero Crater', solLen: 1.02749125 }
};
function currentSol(rover){
  const m = ROVER_META[rover];
  if(!m) return null;
  const days = (Date.now() - new Date(m.landing + 'T00:00:00Z').getTime()) / 86400000;
  return Math.max(0, Math.floor(days / m.solLen));
}
function solForEarthDate(rover, iso){
  const m = ROVER_META[rover];
  if(!m || !iso) return null;
  const days = (new Date(iso + 'T00:00:00Z').getTime() - new Date(m.landing + 'T00:00:00Z').getTime()) / 86400000;
  return days < 0 ? 0 : Math.floor(days / m.solLen);
}
let marsRover = 'Curiosity';
let marsPhotos = [];
let marsFetched = false;
const MarsStatus = { manifestDead: false };
/* the raw-images feed is slow (~20 s), so keep what it returns: switching camera or flipping
   between sol and Earth-date then filters locally instead of paying for another round trip */
const MarsCache = {
  _m: new Map(),
  get(k){ return this._m.get(k) || null; },
  set(k, v){
    if(this._m.size >= 12) this._m.delete(this._m.keys().next().value);
    this._m.set(k, v);
  }
};
function marsCameraOptions(){
  $('mars-camera').innerHTML = '<option value="">all cameras</option>' +
    ROVERS[marsRover].cameras.map(c => `<option value="${c}">${c}</option>`).join('');
}
/* seed the pickers from the rover's live sol — the input bounds are derived, never hardcoded */
function marsSeedSol(){
  const meta = ROVER_META[marsRover];
  $('mars-earth').min = meta.landing;
  $('mars-earth').max = todayIso;
  if(!$('mars-earth').value) $('mars-earth').value = todayIso;
  const sol = currentSol(marsRover);
  if(sol == null) return;
  window.marsMaxSol = sol;
  $('mars-sol').max = String(sol);
  $('mars-sol').value = String(sol);
}
marsCameraOptions();
marsSeedSol();
document.querySelectorAll('.rover-tab').forEach(t => t.addEventListener('click', () => {
  if(t.dataset.rover === marsRover) return;
  document.querySelectorAll('.rover-tab').forEach(x => x.classList.toggle('active', x === t));
  marsRover = t.dataset.rover;
  marsCameraOptions();
  marsSeedSol();                            // jump to the newly selected rover's current sol
  marsPhotos = []; marsFetched = false;
  $('mars-note').textContent = '';
  $('mars-grid').innerHTML = '<span class="loading">press “fetch photos” to load ' + ROVERS[marsRover].name + ' imagery…</span>';
  $('rover-stats').innerHTML = '';
  $('mars-latest').innerHTML = '<span class="loading">checking rover status…</span>';
  Charts.refresh('mars');
  loadMarsLatest();
}));
$('mars-mode').addEventListener('change', () => {
  const bySol = $('mars-mode').value === 'sol';
  $('mars-sol').style.display = bySol ? '' : 'none';
  $('mars-earth').style.display = bySol ? 'none' : '';
});
/* once a query has been run, changing a filter re-runs it — no second button press needed
   (debounced: the raw feed is slow and each request costs ~20 s) */
$('mars-sol').addEventListener('change', () => { if(marsFetched) loadMarsPhotos(); });
$('mars-earth').addEventListener('change', debounce(() => { if(marsFetched) loadMarsPhotos(); }, 350));
$('mars-camera').addEventListener('change', debounce(() => {
  if(marsFetched) loadMarsPhotos();
  else $('mars-note').textContent = 'camera selected — press “fetch photos”';
}, 350));
async function loadMarsPhotos(){
  const token = Seq.next('mars');
  const bySol = $('mars-mode').value === 'sol';
  const cam = $('mars-camera').value;
  // hard-validate the sol field: clamped to [0, max] so out-of-range values can't reach the API
  const solEl = $('mars-sol');
  const solMin = Number(solEl.min || 0);
  const solMax = Number(solEl.max || 0) || currentSol(marsRover) || 999999;
  solEl.max = String(solMax);
  solEl.value = String(Math.min(solMax, Math.max(solMin, Math.floor(Number(solEl.value) || 0))));
  const earthDate = $('mars-earth').value || todayIso;
  const requestedSol = bySol ? Number(solEl.value) : solForEarthDate(marsRover, earthDate);
  marsFetched = true;
  $('mars-note').textContent = 'querying ' + ROVERS[marsRover].name + '…';
  $('mars-grid').innerHTML = '<span class="loading">loading imagery — the raw-images feed can take ~20 s…</span>';

  let photos = null, source = null, solUsed = null, rawCount = 0, samplePhotos = false;

  /* tier 1 — mars.nasa.gov raw-images feed: genuine rover frames, key-less, so it keeps
     working even when the shared api.nasa.gov quota is spent */
  try{
    const cacheKey = marsRover + '|' + (requestedSol != null ? requestedSol : 'latest');
    let raw = MarsCache.get(cacheKey);
    if(!raw){
      raw = await SampleData.rawRoverImages(marsRover, requestedSol, msg => {
        if(!Seq.isStale('mars', token)) $('mars-note').textContent = msg;
      });
      if(raw) MarsCache.set(cacheKey, raw); // never cache a miss — a retry should really retry
    }
    if(Seq.isStale('mars', token)) return;
    if(raw && raw.images.length){
      const mapped = raw.images.map(im => ({
        id: im.imageid || im.id || im.title,
        sol: im.sol,
        earth_date: (im.date_taken_utc || '').slice(0, 10) || todayIso,
        img_src: im.image_files.medium || im.image_files.small,
        camera: {
          name: SampleData.rawInstrument(im) || 'RAW',
          full_name: (im.camera && im.camera.name) || im.title || 'Raw browse image'
        },
        rover: { name: ROVERS[marsRover].name }
      }));
      solUsed = raw.sol; rawCount = mapped.length; source = 'raw';
      if(raw.sol != null) $('mars-sol').max = String(Math.max(Number($('mars-sol').max) || 0, raw.sol));
      photos = cam ? mapped.filter(p => String(p.camera.name).toUpperCase().startsWith(cam.toUpperCase())) : mapped;
    }
  }catch(e){
    // rate-limited, offline or too slow — fall through to the keyed endpoint, then samples
    if(Seq.isStale('mars', token)) return;
  }

  /* tier 2 — the documented Rover Photos API on api.nasa.gov (best with a personal key; when
     the demo quota is out it answers 404 + OVER_RATE_LIMIT, which nasaFetch now flags) */
  if(!photos){
    try{
      const param = bySol ? `sol=${solEl.value}` : `earth_date=${earthDate}`;
      const url = `https://api.nasa.gov/mars-photos/api/v1/rovers/${marsRover}/photos?${param}${cam ? '&camera=' + cam : ''}&api_key=${getNasaKey()}`;
      const d = await staggeredNasaFetch(url, { label: 'Mars Photos' });
      if(Seq.isStale('mars', token)) return;
      if(d && Array.isArray(d.photos) && d.photos.length){
        photos = d.photos; source = 'api'; solUsed = d.photos[0].sol;
        if(d.photos[0].rover && d.photos[0].rover.max_sol) $('mars-sol').max = String(d.photos[0].rover.max_sol);
      }
    }catch(e){
      if(Seq.isStale('mars', token)) return;
    }
  }

  /* tier 3 — built-in sample frames so the grid is never blank while a feed is unavailable */
  if(!photos){
    photos = SampleData.marsPhotos(marsRover, requestedSol != null ? requestedSol : earthDate);
    samplePhotos = true;
  }
  marsPhotos = photos || [];
  const camMiss = source === 'raw' && marsPhotos.length === 0 && rawCount > 0;
  $('mars-note').innerHTML = camMiss
    ? rawCount + ' frames on sol ' + solUsed + ' · none from ' + esc(cam) + SampleData.badge('live · raw feed')
    : marsPhotos.length + ' photos returned'
      + (source === 'raw' ? SampleData.badge('live · raw feed') : '')
      + (source === 'api' ? SampleData.badge('live · api') : '')
      + (samplePhotos ? SampleData.badge() : '')
      + (source === 'raw' && requestedSol != null && solUsed != null && Number(solUsed) !== Number(requestedSol)
          ? ' · showing sol ' + solUsed + (Number(requestedSol) > Number(solUsed) ? ' (newest downlinked)' : '')
          : '');
    $('tile-mars-count').textContent = marsPhotos.length;
    $('tile-mars-sub').textContent = ROVERS[marsRover].name + ' · ' + (bySol ? 'sol ' + ($('mars-sol').value || 0) : earthDate);
    if(marsPhotos.length === 0){
      const why = (cam && source === 'raw')
        ? rawCount + ' frames came back for that sol, but none from ' + esc(cam) + '. Try another camera or sol.'
        : 'No photos for that query. Rovers skip sols and reserve some cameras for occasional use.';
      $('mars-grid').innerHTML = '<div class="empty">' + why + '</div>';
    } else {
      $('mars-grid').innerHTML = marsPhotos.slice(0, 24).map(p => `
        <div class="mars-item" data-img="${esc(p.img_src)}" data-title="${esc(p.rover.name)} · ${esc(p.camera.full_name)}" data-meta="sol ${p.sol} · ${p.earth_date} · ${esc(p.camera.name)}" data-text="Raw image ${p.id} from the ${esc(p.camera.full_name)} aboard ${esc(p.rover.name)}, taken on Mars solar day (sol) ${p.sol} — Earth date ${p.earth_date}.">
          <img src="${esc(p.img_src)}" alt="${esc(p.camera.full_name)}" loading="lazy" />
          <div class="cap">${esc(p.camera.name)} · sol ${p.sol}</div>
        </div>`).join('');
      $('mars-grid').querySelectorAll('.mars-item').forEach(el => el.addEventListener('click', () => openModal({
        title: el.dataset.title, meta: el.dataset.meta, url: el.dataset.img, hdurl: el.dataset.img, text: el.dataset.text
      })));
    }
    Charts.buildMars();
}
$('mars-load').addEventListener('click', loadMarsPhotos);

async function loadMarsLatest(){
  const token = Seq.next('marsmeta');
  const meta = ROVER_META[marsRover];
  $('rover-stats').innerHTML = '<span class="loading">checking rover status…</span>';
  let ph = null;
  // the manifest endpoint is best-effort: it currently answers a plain 404 ("No such app"),
  // so remember that and stop spending requests on it for the rest of the session
  if(!MarsStatus.manifestDead){
    try{
      const d = await staggeredNasaFetch(`https://api.nasa.gov/mars-photos/api/v1/manifests/${marsRover}?api_key=${getNasaKey()}`, { label: 'Mars Manifest' });
      if(Seq.isStale('marsmeta', token)) return;
      ph = (d && d.photo_manifest) || null;
      if(!ph) MarsStatus.manifestDead = true;
    }catch(e){
      if(Seq.isStale('marsmeta', token)) return;
      // a throttle is transient (retry later); a 404 / non-JSON answer means it is gone
      if(!(e && (e.rateLimited || e.network))) MarsStatus.manifestDead = true;
    }
  }
  if(ph){
    // dynamic bounds straight from the live manifest — never hardcoded dates
    window.marsMaxSol = ph.max_sol || window.marsMaxSol || null;
    $('mars-sol').max = String(ph.max_sol || currentSol(marsRover) || 999999);
    $('mars-earth').min = ph.landing_date || meta.landing;
    $('mars-earth').max = todayIso;
    $('rover-stats').innerHTML = `
      <span>launch <b>${ph.launch_date}</b></span>
      <span>landing <b>${ph.landing_date}</b></span>
      <span>max sol <b>${ph.max_sol}</b></span>
      <span>total photos <b>${(ph.total_photos || 0).toLocaleString()}</b></span>
      <span>status <b>${esc(ph.status || 'active')}</b></span>`;
    const recent = [...(ph.photos || [])].sort((a, b) => b.sol - a.sol).slice(0, 3);
    $('mars-latest').innerHTML = `
      <div class="kv"><span class="k">MISSION</span><span class="v">${esc(ph.name)}</span></div>
      <div class="kv"><span class="k">ON MARS SINCE</span><span class="v">${ph.landing_date}</span></div>
      <div class="kv"><span class="k">SOLS ELAPSED</span><span class="v">${ph.max_sol}</span></div>
      <div class="kv"><span class="k">PHOTOS RETURNED</span><span class="v">${(ph.total_photos || 0).toLocaleString()}</span></div>
      <div class="kv"><span class="k">RECENT SOLS</span><span class="v">${recent.map(r => r.sol + ' (' + r.total_photos + ')').join(' · ')}</span></div>`;
    return;
  }
  /* manifest unavailable — derive the panel from the sol clock plus known mission facts so
     this card stays informative and the pickers keep correct bounds */
  const sol = currentSol(marsRover);
  window.marsMaxSol = sol;
  $('mars-sol').max = String(sol);
  $('mars-earth').min = meta.landing;
  $('mars-earth').max = todayIso;
  $('rover-stats').innerHTML = `
    <span>launch <b>${meta.launch}</b></span>
    <span>landing <b>${meta.landing}</b></span>
    <span>sol now <b>${sol}</b></span>
    <span>landing site <b>${esc(meta.site)}</b></span>`;
  $('mars-latest').innerHTML = `
    <div class="kv"><span class="k">ROVER</span><span class="v">${esc(ROVERS[marsRover].name)}</span></div>
    <div class="kv"><span class="k">LANDING SITE</span><span class="v">${esc(meta.site)}</span></div>
    <div class="kv"><span class="k">ON MARS SINCE</span><span class="v">${meta.landing}</span></div>
    <div class="kv"><span class="k">SOL CLOCK</span><span class="v">sol ${sol} · derived from the rover's mission clock</span></div>
    <div class="kv"><span class="k">MANIFEST FEED</span><span class="v">unavailable · using the key-less raw-images feed</span></div>`;
}
// initial manifest load is staggered from the boot block

export { loadMarsLatest };

export function loadMarsLatestPublic(){ return loadMarsLatest(); }

export function marsPhotosOf(){ return marsPhotos; }
export function marsRoverOf(){ return ROVERS[marsRover] || { name: marsRover }; }
