import { toast } from '../ui.js';
/* ================================================================
   Vantage — js/modules/apod.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */
import { $, Store, httpJSON, esc, fmt, num, isoDate, nasaFetch, staggeredNasaFetch, todayIso, Seq, Retry, SampleData } from '../api.js';
/* ================================================================
   APOD + bookmarks
   ================================================================ */
let currentApod = null;
const apodDateInput = $('apod-date');
apodDateInput.max = todayIso;
apodDateInput.value = todayIso;

let bookmarks = Store.getJSON('vantage-bm', []);
if(!Array.isArray(bookmarks)) bookmarks = [];
function saveBookmarks(){
  Store.setJSON('vantage-bm', bookmarks);
  renderBookmarks();
  $('bookmarkBtn').classList.toggle('on', isBookmarked());
}
function isBookmarked(){
  return currentApod && bookmarks.some(b => b.date === currentApod.date);
}
function renderBookmarks(){
  const grid = $('bm-grid');
  $('bm-count').textContent = bookmarks.length + ' saved';
  $('bm-empty').style.display = bookmarks.length ? 'none' : 'block';
  grid.innerHTML = bookmarks.map((b, i) => `
    <div class="bm-item" data-i="${i}">
      <img src="${esc(b.thumb || b.url)}" alt="${esc(b.title)}" loading="lazy" />
      <div class="bm-t">${esc(b.title)}</div>
      <div class="bm-d">${esc(b.date)}</div>
      <button class="bm-x" title="Remove bookmark" aria-label="Remove this bookmark">✕</button>
    </div>`).join('');
  grid.querySelectorAll('.bm-item').forEach(el => {
    el.addEventListener('click', e => {
      const i = Number(el.dataset.i);
      if(e.target.classList.contains('bm-x')){
        bookmarks.splice(i, 1); saveBookmarks(); toast('Bookmark removed'); return;
      }
      openModal(bookmarks[i]);
    });
  });
}
function clearModalMedia(){
  const slot = $('modalMedia');
  if(!slot) return;
  slot.innerHTML = '';
}
function openModal(b){

  const slot = $('modalMedia');
  clearModalMedia();
    const img = document.createElement('img');
    img.id = 'modalImg';
    img.alt = b.title || '';
    img.src = b.hdurl || b.url || '';
    slot.appendChild(img);
  /* feeds label the caption differently — APOD sends date/explanation, EPIC and Mars send
     meta/text — and reading only one naming opened those modals with an empty caption */
  $('modalTitle').textContent = b.title || '';
  $('modalMeta').textContent = [b.date || b.meta || '', b.copyright ? '· © ' + b.copyright : ''].filter(Boolean).join(' ');
  $('modalText').textContent = b.explanation || b.text || '';
  $('modalBackdrop').classList.add('open');
}
function closeModal(){
  $('modalBackdrop').classList.remove('open');
  clearModalMedia();   // blank the src, then drop the node — no audio behind a closed modal
}
$('modalClose').addEventListener('click', closeModal);
$('modalBackdrop').addEventListener('click', e => { if(e.target === $('modalBackdrop')) closeModal(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeModal(); });

$('bookmarkBtn').addEventListener('click', () => {
  if(!currentApod) return;
  if(isBookmarked()){
    bookmarks = bookmarks.filter(b => b.date !== currentApod.date);
    toast('Bookmark removed');
  } else {
    bookmarks.unshift({ date: currentApod.date, title: currentApod.title, url: currentApod.url, hdurl: currentApod.hdurl, thumb: currentApod.thumbnail_url || currentApod.url, explanation: currentApod.explanation, copyright: currentApod.copyright });
    toast('Saved to bookmarks');
  }
  saveBookmarks();
});

const APOD_ARCHIVE_START = '1995-06-16';
const APOD_MAX_WALKBACK = 4;
function apodPrevDate(dateStr){
  const d = new Date(dateStr + 'T00:00:00Z');
  if(isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  const iso = isoDate(d);
  return iso >= APOD_ARCHIVE_START ? iso : null; // clamp at the archive boundary — never recurse past it
}
async function loadApod(dateStr, depth = 0){
  // every retry/step of the same walk-back shares one generation, so only a *new* date wins
  const token = depth === 0 ? Seq.next('apod') : Seq.current('apod');
  $('apod-title').textContent = 'Loading…';
  $('apod-explanation').textContent = '';
  $('apod-credit').textContent = '';
  $('apod-media').innerHTML = '<span class="loading">fetching image…</span>';
  try{
    const d = await staggeredNasaFetch(`https://api.nasa.gov/planetary/apod?api_key=${getNasaKey()}&date=${dateStr}`, { label: 'APOD' });
    if(Seq.isStale('apod', token)) return;
    currentApod = d;
    apodDateInput.value = d.date;
    if(d.date > todayIso) todayIso = d.date;
    $('apod-date-label').textContent = d.date;
    $('apod-title').textContent = d.title;
    $('apod-explanation').textContent = d.explanation;
    $('apod-credit').textContent = d.copyright ? '© ' + d.copyright : '';
    const mediaEl = $('apod-media');
    if(d.media_type === 'image'){
      mediaEl.innerHTML = `<img src="${esc(d.hdurl || d.url)}" alt="${esc(d.title)}" />`;
    } else {
      mediaEl.innerHTML = '<span class="loading">no preview available for this entry</span>';
    }
    $('bookmarkBtn').classList.toggle('on', isBookmarked());
    buildBrief();
  }catch(e){
    if(Seq.isStale('apod', token)) return;
    if(e && (e.rateLimited || e.network)){
      // demo key exhausted OR the request timed out — degrade to real, key-less NASA imagery first
      return renderLibraryApod(dateStr, token);
    }
    // future UTC dates (and occasional gaps) have no APOD — walk back day by day, bounded
    const prev = apodPrevDate(dateStr);
    if(e && e.httpStatus === 404 && depth < APOD_MAX_WALKBACK && prev){
      return loadApod(prev, depth + 1);
    }
    $('apod-title').textContent = 'Could not load this date';
    $('apod-explanation').textContent = 'The request failed. Try again shortly, or pick a different date.';
    $('apod-media').innerHTML = Retry.card('no image — the APOD request failed.', 'apod', () => loadApod(dateStr));
  }
}
function renderSampleApod(d){
  apodDateInput.value = d.date;
  $('apod-date-label').innerHTML = d.date + SampleData.badge();
  $('apod-title').textContent = d.title;
  $('apod-explanation').textContent = d.explanation;
  $('apod-credit').textContent = d.copyright ? '© ' + d.copyright : '';
  $('apod-media').innerHTML = `<img src="${esc(d.hdurl || d.url)}" alt="${esc(d.title)}" />`;
  $('bookmarkBtn').classList.remove('on');
}

/* Key-less fallback: pick a real NASA image from images-api.nasa.gov,
   deterministically seeded by the requested date so each day differs. */
const LIBRARY_QUERIES = ['orion nebula','carina nebula','eagle nebula','sombrero galaxy','whirlpool galaxy','saturn cassini','jupiter great red spot','andromeda galaxy','aurora from space','iss spacewalk','mars surface panorama','pillar of creation'];
async function renderLibraryApod(dateStr, token){
  $('apod-media').innerHTML = '<span class="loading">fetching from the NASA image library…</span>';
  $('apod-explanation').textContent = '';
  try{
    const h = String(dateStr).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const q = LIBRARY_QUERIES[h % LIBRARY_QUERIES.length];
    const d = await nasaFetch(`https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=image&page_size=30`, { label: 'NASA Image Library' });
    if(Seq.isStale('apod', token)) return;
    const items = ((d.collection && d.collection.items) || []).filter(it =>
      it.links && it.links[0] && it.links[0].href && it.data && it.data[0] && it.data[0].title);
    if(!items.length) throw new Error('library empty');
    const it = items[h % items.length];
    const meta = it.data[0];
    const thumb = it.links[0].href;
    const big = meta.nasa_id ? `https://images-assets.nasa.gov/image/${meta.nasa_id}/${meta.nasa_id}~medium.jpg` : thumb;
    currentApod = { date: dateStr, title: meta.title, explanation: meta.description || '', url: thumb, hdurl: big, media_type: 'image', copyright: meta.secondary_creator || (meta.center ? 'NASA ' + meta.center : 'NASA') };
    apodDateInput.value = dateStr;
    $('apod-date-label').innerHTML = `${dateStr} · ${esc(q)} · NASA Image Library${SampleData.badge('library')}`;
    $('apod-title').textContent = currentApod.title;
    $('apod-explanation').textContent = currentApod.explanation;
    $('apod-credit').textContent = currentApod.copyright ? '© ' + currentApod.copyright : '';
    $('apod-media').innerHTML = `<img src="${esc(big)}" onerror="this.onerror=null;this.src='${esc(thumb)}'" alt="${esc(currentApod.title)}" />`;
    $('bookmarkBtn').classList.remove('on');
    buildBrief();
  }catch(e2){
    if(Seq.isStale('apod', token)) return;
    // last tier: built-in sample so the panel never goes blank
    currentApod = SampleData.apod(dateStr);
    renderSampleApod(currentApod);
    buildBrief();
  }
}
$('apod-prev').addEventListener('click', () => {
  const d = new Date(apodDateInput.value + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  loadApod(isoDate(d));
});
$('apod-next').addEventListener('click', () => {
  const d = new Date(apodDateInput.value + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  if(isoDate(d) <= todayIso) loadApod(isoDate(d));
});
$('apod-random').addEventListener('click', () => {
  const start = new Date(APOD_ARCHIVE_START + 'T00:00:00Z').getTime();
  const end = new Date(todayIso + 'T00:00:00Z').getTime();
  if(end <= start){ toast('APOD feed unavailable — try again shortly'); return; }
  const rand = new Date(start + Math.random() * (end - start));
  loadApod(isoDate(rand));
});
apodDateInput.addEventListener('change', () => loadApod(apodDateInput.value));
// initial load is staggered from the boot block to protect the shared demo key
renderBookmarks();

/* ================================================================
   EPIC — Earth full disc
   ================================================================ */
const epicDate = $('epic-date');
epicDate.max = todayIso;
async function loadEpic(dateStr){
  const token = Seq.next('epic');
  const strip = $('epic-strip');
  strip.innerHTML = '<span class="loading">fetching EPIC imagery…</span>';
  $('epic-note').textContent = 'loading…';
  let arr = null;
  try{
    const q = dateStr ? `?date=${dateStr}` : '';
    arr = await staggeredNasaFetch('https://epic.gsfc.nasa.gov/api/natural' + q, { label: 'EPIC' });
    if(Seq.isStale('epic', token)) return;
    if(!Array.isArray(arr) || arr.length === 0) arr = null;
  }catch(e){
    if(Seq.isStale('epic', token)) return;
    if(e && (e.rateLimited || e.network)){
      arr = SampleData.epic();
    } else {
      strip.innerHTML = Retry.card('Could not reach the EPIC archive — check your connection.', 'epic', () => loadEpic(dateStr));
      $('epic-note').textContent = 'failed';
      return;
    }
  }
  const isSample = arr === null ? false : arr[0].image && String(arr[0].image).startsWith('sample-');
  if(!arr){
    strip.innerHTML = '<div class="empty">No EPIC imagery for that date (archive starts 2015-06-13, and coverage can skip days). Try an earlier date.</div>';
    $('epic-note').textContent = 'no imagery';
    return;
  }
  const d0 = arr[0].date.slice(0, 10);
  epicDate.value = d0;
  $('epic-meta').innerHTML = d0 + ' · natural color · ' + arr.length + ' frames' + (isSample ? SampleData.badge() : '');
  $('epic-note').textContent = 'showing ' + d0 + ' — click a frame to enlarge';
  strip.innerHTML = arr.slice(0, 8).map((e, idx) => {
    const [date, time] = e.date.split(' ');
    const [y, m, day] = date.split('-');
    const url = isSample
      ? SampleData.epicUrl(idx)
      : `https://epic.gsfc.nasa.gov/archive/natural/${y}/${m}/${day}/jpg/${e.image}.jpg`;
    return `<div class="epic-item" data-img="${esc(url)}" data-title="Earth — full disc${isSample ? ' (sample)' : ''}" data-meta="DSCOVR EPIC · ${esc(e.date)} UTC" data-text="${isSample ? 'Built-in sample frame shown while the EPIC feed is rate-limited. ' : ''}Captured by NASA's Earth Polychromatic Imaging Camera aboard DSCOVR, about 1.6 million km sunward of Earth. ${esc(e.caption || '')}">
      <img src="${esc(url)}" alt="Earth from EPIC ${esc(e.date)}" loading="lazy" />
      <div class="cap">${esc(e.date.slice(11, 16))} UTC</div>
    </div>`;
  }).join('');
  strip.querySelectorAll('.epic-item').forEach(el => el.addEventListener('click', () => openModal({
    title: el.dataset.title, meta: el.dataset.meta, url: el.dataset.img, hdurl: el.dataset.img, text: el.dataset.text
  })));
}
$('epic-load').addEventListener('click', () => loadEpic(epicDate.value || null));
// initial load is staggered from the boot block

export { loadApod, loadEpic };

export function loadApodPublic(d){ return loadApod(d); }
export function loadEpicPublic(d){ return loadEpic(d); }

export { clearModalMedia, openModal, closeModal };
export function currentApodOf(){ return currentApod; }
