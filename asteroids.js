import { Range } from '../ui.js';
/* ================================================================
   Vantage — js/modules/asteroids.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */
import { $, Store, httpJSON, esc, fmt, num, isoDate, staggeredNasaFetch, fmtv, todayIso, Seq, Retry, SampleData } from '../api.js';
import { Charts } from './charts.js';
/* ================================================================
   NEO — Near Earth Objects
   ================================================================ */
let allNeos = [];
let neoSortKey = 'miss', neoSortAsc = true;
/* the header declares its column as "miss" but the flattened row stores "missLunar" —
   without this map that one lookup is undefined on every row, the comparator returns 0
   for all pairs, and the default column silently never sorts */
const NEO_SORT_FIELD = { name: 'name', date: 'date', miss: 'missLunar', vel: 'vel', diam: 'diam', mag: 'mag' };
/* NeoWs guarantees none of estimated_diameter / close_approach_data / relative_velocity /
   miss_distance, and a single object missing one of them used to throw out of the map and
   leave the whole table on "fetching feed…". Every read goes through neoPick() and yields
   null instead, so one bad record costs one cell, not the view. */
function neoPick(root, ...path){
  let cur = root;
  for(const key of path){
    if(cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = cur[key];
  }
  return cur === undefined ? null : cur;
}
function neoMidSize(d){
  const min = num(neoPick(d, 'meters', 'estimated_diameter_min'));
  const max = num(neoPick(d, 'meters', 'estimated_diameter_max'));
  if(min === null && max === null) return null;
  if(min === null) return max;
  if(max === null) return min;
  return (min + max) / 2;
}
function flattenNeos(feed){
  const rows = [];
  Object.entries((feed && feed.near_earth_objects) || {}).forEach(([date, list]) => {
    (Array.isArray(list) ? list : []).forEach(o => {
      if(!o || typeof o !== 'object') return;
      const approaches = Array.isArray(o.close_approach_data) ? o.close_approach_data : [];
      const c = approaches[0];
      if(!c || typeof c !== 'object') return;   // no approach record — nothing to plot
      const when = c.close_approach_date_full || c.close_approach_date || date;
      const epoch = new Date(when).getTime();
      rows.push({
        name: o.name || o.id || 'unnamed object',
        hazardous: o.is_potentially_hazardous_asteroid === true,
        date: c.close_approach_date || date || '—',
        epoch: Number.isFinite(epoch) ? epoch : 0,
        missLunar: num(neoPick(c, 'miss_distance', 'lunar')),
        missKm: num(neoPick(c, 'miss_distance', 'kilometers')),
        vel: num(neoPick(c, 'relative_velocity', 'kilometers_per_second')),
        diam: neoMidSize(o.estimated_diameter),
        diamMax: num(neoPick(o, 'estimated_diameter', 'meters', 'estimated_diameter_max')),
        mag: num(o.absolute_magnitude_h)
      });
    });
  });
  return rows;
}
/* the arrows live in the header text rather than being hardcoded in the markup, so they
   always describe the sort that is actually applied */
function paintNeoSortHeaders(){
  document.querySelectorAll('table.neo th[data-sort]').forEach(th => {
    if(!th.dataset.label) th.dataset.label = th.textContent.replace(/[↑↓]\s*$/, '').trim();
    const active = th.dataset.sort === neoSortKey;
    th.textContent = th.dataset.label + (active ? (neoSortAsc ? ' ↑' : ' ↓') : '');
    th.setAttribute('aria-sort', active ? (neoSortAsc ? 'ascending' : 'descending') : 'none');
  });
}
function renderNeo(){
  const q = $('neo-search').value.trim().toLowerCase();
  const hazardOnly = $('neo-hazard-only').checked;
  const rows = allNeos.filter(r =>
    (!q || String(r.name).toLowerCase().includes(q)) && (!hazardOnly || r.hazardous));

  // a missing value sorts to the bottom of either direction rather than falling through as
  // 0 and reading as the closest/slowest object of the set
  const field = NEO_SORT_FIELD[neoSortKey] || neoSortKey;
  rows.sort((a, b) => {
    const x = a[field], y = b[field];
    const xn = x === null || x === undefined, yn = y === null || y === undefined;
    if(xn || yn) return xn && yn ? 0 : (xn ? 1 : -1);
    const r = (typeof x === 'string' || typeof y === 'string')
      ? String(x).localeCompare(String(y))
      : (x > y ? 1 : x < y ? -1 : 0);
    return neoSortAsc ? r : -r;
  });
  paintNeoSortHeaders();

  // NaN-safe bar scaling: an empty/NaN max would poison every width below
  const maxMiss = Math.max(...rows.map(r => Number(r.missLunar) || 0), 1);
  const maxDiam = Math.max(...rows.map(r => Number(r.diam) || 0), 1);
  const pct = (v, max) => (Number.isFinite(v) && Number.isFinite(max) && max > 0)
    ? Math.min(100, Math.max(2, (v / max) * 100)).toFixed(0)
    : '0';
  $('neo-body').innerHTML = rows.length === 0
    ? '<tr><td colspan="6" class="empty">No near-Earth objects match that filter.</td></tr>'
    : rows.map(r => `
      <tr class="${r.hazardous ? 'hazard' : ''}">
        <td class="name-cell">${esc(r.name)}</td>
        <td>${esc(r.date)}</td>
        <td>${fmtv(r.missLunar, 1)} LD<div class="bar-cell"><div class="bar" style="width:${pct(r.missLunar, maxMiss)}%;opacity:.75"></div></div></td>
        <td>${fmtv(r.vel, 2)}</td>
        <td>${fmtv(r.diam, 0)}<div class="bar-cell"><div class="bar" style="width:${pct(r.diam, maxDiam)}%;opacity:.6;background:linear-gradient(90deg,var(--warm),var(--hot))"></div></div></td>
        <td>${fmtv(r.mag, 1)}</td>
      </tr>`).join('');
}
function neoKpis(isSample){
  const n = allNeos.length;
  $('neo-k-count').textContent = n;
  $('badge-neo').textContent = n;
  $('tile-neo-count').textContent = n;
  const hz = allNeos.filter(r => r.hazardous).length;
  $('neo-k-hazard').textContent = hz;
  $('tile-neo-sub').textContent = hz + ' flagged hazardous';
  // rank only objects that actually carried the field being ranked on
  const withMiss = allNeos.filter(r => Number.isFinite(r.missLunar));
  const withDiam = allNeos.filter(r => Number.isFinite(r.diam));
  const closest = withMiss.length ? withMiss.reduce((a, b) => b.missLunar < a.missLunar ? b : a) : null;
  const largest = withDiam.length ? withDiam.reduce((a, b) => b.diam > a.diam ? b : a) : null;
  $('neo-k-closest').textContent = closest ? fmt(closest.missLunar, 1) + ' LD' : '—';
  $('neo-k-closest-name').textContent = closest ? closest.name : 'no approach distance in range';
  $('neo-k-largest').textContent = largest ? fmt(largest.diam, 0) + ' m' : '—';
  $('neo-k-largest-name').textContent = largest ? largest.name : 'no size estimate in range';
  $('top-neo-card').innerHTML = closest ? `
      <div style="font-size:17px;font-weight:600">${esc(closest.name)}${isSample ? SampleData.badge() : ''}</div>
      <div style="font-size:12.5px;color:var(--text-2);margin:4px 0 12px">closest approach in range${closest.hazardous ? ' · ⚠ flagged hazardous' : ''}</div>
      <div class="kv"><span class="k">MISS DISTANCE</span><span class="v">${fmt(closest.missLunar, 1)} lunar${Number.isFinite(closest.missKm) ? ' · ' + fmt(closest.missKm / 1e6, 2) + 'M km' : ''}</span></div>
      <div class="kv"><span class="k">REL. VELOCITY</span><span class="v">${fmtv(closest.vel, 2)} km/s</span></div>
      <div class="kv"><span class="k">EST. DIAMETER</span><span class="v">${fmtv(closest.diam, 0)} m</span></div>
      <div class="kv"><span class="k">APPROACH DATE</span><span class="v">${esc(closest.date)}</span></div>`
    : `<div style="font-size:12.5px;color:var(--text-2)">${n ? 'The objects in this window came back without close-approach distances, so there is nothing to rank.' : 'No near-Earth objects were returned for this window.'}</div>`;
  $('neo-meta').textContent = `NeoWs · ${Range.start || 'today'} → ${Range.end || 'window'}`;
}
async function loadNeo(){
  const token = Seq.next('neo');
  const start = Range.start || todayIso;
  const end = Range.end || isoDate(new Date(Date.now() + 7 * 86400000));
  $('neo-body').innerHTML = '<tr><td colspan="6" class="loading" style="padding:30px">fetching feed…</td></tr>';
  try{
    const feed = await staggeredNasaFetch(`https://api.nasa.gov/neo/rest/v1/feed?start_date=${start}&end_date=${end}&api_key=${getNasaKey()}`, { label: 'NeoWs' });
    if(Seq.isStale('neo', token)) return; // a newer window has superseded this request
    allNeos = flattenNeos(feed);
    neoKpis();
  }catch(e){
    if(Seq.isStale('neo', token)) return;
    if(e && (e.rateLimited || e.network)){
      allNeos = SampleData.neo(start, end);
      neoKpis(true);
    } else {
      $('neo-body').innerHTML = '<tr><td colspan="6">' + Retry.card('Could not reach the NeoWs feed — check your connection.', 'neo', loadNeo) + '</td></tr>';
      $('tile-neo-count').textContent = '!';
      $('tile-neo-sub').textContent = 'feed unavailable';
      return;
    }
  }
  if(Seq.isStale('neo', token)) return;
  renderNeo();
  Charts.buildNeos();
  buildBrief();
}
$('neo-search').addEventListener('input', renderNeo);
$('neo-hazard-only').addEventListener('change', renderNeo);
document.querySelectorAll('table.neo th').forEach(th => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  // a first click on any column sorts ascending, so the arrow always matches the data
  if(neoSortKey === key) neoSortAsc = !neoSortAsc; else { neoSortKey = key; neoSortAsc = true; }
  renderNeo();
}));

export { loadNeo };

export function loadNeoPublic(){ return loadNeo(); }

export function allNeosOf(){ return allNeos; }
