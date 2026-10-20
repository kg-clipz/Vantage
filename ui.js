import { applyBasemap, refreshMapSoon, refreshEventsMapSoon, ensureEventsMap } from './modules/iss.js';
import { Aurora } from './modules/aurora.js';
import { Charts } from './modules/charts.js';
import { clearModalMedia, openModal, closeModal } from './modules/apod.js';
/* ================================================================   Vantage — js/ui.js   Shared furniture: toasts, theme, the UTC clock, view routing and   the global date range (cut verbatim from the monolith's boot slice).   ================================================================ */import { $, Store, isoDate, debounce, pad } from './api.js';
function toast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------------- theme ---------------- */
const themeBtn = $('themeToggle');
function applyTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  themeBtn.textContent = t === 'dark' ? '☾' : '☀';
  Store.set('vantage-theme', t);
  Charts.retheme();
  applyBasemap(); // dark and light tile sets are different services — swap, don't filter
}
themeBtn.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});
const savedTheme = Store.get('vantage-theme', null)
  || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
// applied at boot (below) once Charts exists

/* ---------------- clock ---------------- */
function tickClock(){
  const now = new Date();
  $('utcClock').innerHTML = `<b>${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}</b> UTC`;
}
tickClock(); setInterval(tickClock, 1000);

/* ---------------- view routing ---------------- */
const VIEW_META = {
  overview:  ['Overview',      'console / overview'],
  sky:       ['Sky & Earth',   'console / sky & earth'],
  missions:  ['Missions',      'console / missions'],
  asteroids: ['Asteroids',     'console / asteroids'],
  mars:      ['Mars',          'console / mars'],
  weather:   ['Space Weather', 'console / space weather'],
  events:    ['Natural Events','console / natural events'],
  jellyfish: ['Space Jellyfish','console / space jellyfish'],
  timeline:  ['Next 24 Hours',  'console / next 24 hours'],
  brief:     ['Analysis',      'console / analysis'],
};
/* Two of these pages re-read their data on entry — the 24-hour outlook and the jellyfish
   outlook — so they are told when they arrive. Lazy lookup, because the modules are declared
   further down the file than showView() is. */
function pageFor(name){
  if(name === 'timeline') return (typeof Timeline !== 'undefined') ? Timeline : null;
  if(name === 'jellyfish') return (typeof Jellyfish !== 'undefined') ? Jellyfish : null;
  return null;
}
function showView(name){
  /* the outgoing page is told first, while it is still the one on screen — this is where the
     page releases what it holds, which is the difference between hidden and stopped */

  if(showView.CUR && showView.CUR !== name){
    const leaving = pageFor(showView.CUR);
    if(leaving && leaving.leave) leaving.leave();
  }
  showView.CUR = name;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  const [title, crumb] = VIEW_META[name] || ['Overview', 'console'];
  $('viewTitle').textContent = title;
  $('crumb').textContent = crumb;
  $('main').scrollTop = 0;
  if(name === 'missions') Charts.refresh('missions');
  if(name === 'asteroids') Charts.refresh('asteroids');
  if(name === 'mars') Charts.refresh('mars');
  if(name === 'weather'){
    Charts.refresh('weather');
    refreshMapSoon();           // re-measure even though the events map moved out of this view
  }
  if(name === 'events'){
    Charts.refresh('events');
    ensureEventsMap();          // built on first visible frame, never at 0×0
    Aurora.attach();            // the overlay waits for a measurable container, like the markers
    refreshEventsMapSoon();
  }
  if(name === 'overview') refreshMapSoon();
  const entering = pageFor(name);
  if(entering && entering.enter) entering.enter();
}
/* overview is the class the markup ships with, so the tracker starts on it — recorded here so
   the first switch away can tell it to leave */
showView.CUR = 'overview';
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

/* ---------------- global date range ---------------- */
const Range = {
  start: null, end: null,
  set(startIso, endIso, { refetchLaunches = true } = {}){
    this.start = startIso; this.end = endIso;
    $('gf-start').value = startIso; $('gf-end').value = endIso;
    if(refetchLaunches) loadLaunches(true); // force: a new window needs fresh data
    loadNeo();
  }
};
(function initRange(){
  const now = new Date();
  $('gf-start').value = isoDate(now);
  $('gf-end').value = isoDate(new Date(now.getTime() + 3 * 86400000));
  Range.start = $('gf-start').value;
  Range.end = $('gf-end').value;
  // flipping through presets used to fire one request per stop (and each one spends demo-key
  // quota) — collapse the burst so only the landing preset is actually fetched
  $('gf-preset').addEventListener('change', debounce(() => {
    const v = $('gf-preset').value;
    if(v === 'custom') return;
    const n = new Date();
    Range.set(isoDate(n), isoDate(new Date(n.getTime() + Number(v) * 86400000)));
    toast(`Range set: next ${v} day${v === '1' ? '' : 's'} — asteroids reloaded, launches re-fetched`);
  }, 350));
  const onCustom = () => {
    const s = $('gf-start').value, e = $('gf-end').value;
    if(s && e && s <= e){ $('gf-preset').value = 'custom'; Range.set(s, e); toast('Custom range applied'); }
  };
  // typing a custom window can emit changes in bursts — collapse them so one request wins
  // instead of several overlapping ones (the generation tokens discard any stragglers)
  const onCustomDebounced = debounce(onCustom, 400);
  $('gf-start').addEventListener('change', onCustomDebounced);
  $('gf-end').addEventListener('change', onCustomDebounced);
})();

export { toast, applyTheme, savedTheme, tickClock, showView, VIEW_META, pageFor, Range };
export { openModal, closeModal, clearModalMedia };
