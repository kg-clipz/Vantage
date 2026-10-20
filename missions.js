import { Jellyfish } from './jellyfish.js';
import { Timeline } from './timeline.js';
import { buildBrief } from './brief.js';
import { Range } from '../ui.js';
import { Charts } from './charts.js';
/* ================================================================
   Vantage — js/modules/missions.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */
import { $, Store, httpJSON, esc, fmt, num, isoDate, pad, Seq, Retry, SampleData } from '../api.js';
/* ================================================================
   Launches
   ================================================================ */
let allLaunches = [];
let launchSortDesc = false;
function statusClass(a){ return statusBucket(a); }
function statusBucket(a){
  if(a === 'Go' || a === 'TBC' || a === 'Success') return 'go';
  if(a === 'TBD' || a === 'Hold') return a === 'TBD' ? 'tbd' : 'hold';
  return 'hold';
}
function inRange(dt){
  const s = Range.start ? new Date(Range.start + 'T00:00:00Z').getTime() : -Infinity;
  const e = Range.end ? new Date(Range.end + 'T23:59:59Z').getTime() : Infinity;
  return dt >= s && dt <= e;
}
function launchDateLabel(dt){
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
/* ---------- payload + vehicle picture, read out of the Launch Library record ----------
   LL2 files what a rocket carries under `mission` — its `name` is the payload's own
   designation ("Starlink Group 9-4", "Crew-9"), and its `type` and `orbit` say what that
   payload is and where it is going. The vehicle photograph is
   `rocket.configuration.image_url`; plenty of configurations publish no image at all, so
   ROCKET_ART.ph() draws a themed placeholder rather than leaving a broken <img> where a
   rocket should be. */
function ll2PayloadName(l){
  const m = (l && l.mission) || {};
  if(m.name && m.name !== 'Unknown Payload') return m.name;
  const n = String((l && l.name) || '');
  if(n.includes('|')){
    const tail = n.split('|').pop().trim();
    /* "Unknown Payload" is a real value in the feed, not a payload — showing it as the cargo
       would state something the record does not say */
    if(tail && !/^unknown payload$/i.test(tail)) return tail;
  }
  return '';
}
function ll2RocketImage(l){
  const c = (l && l.rocket && l.rocket.configuration) || {};
  return /^https?:\/\//i.test(c.image_url || '') ? c.image_url : '';
}
const ROCKET_ART = {
  /* A data-URI placeholder: a launch with no published photograph still paints a vehicle
     instead of an empty box, with no network request, no broken-image icon and no extra asset
     to ship. The label is the vehicle family, stripped to characters an SVG text node can hold. */
  ph(label){
    const tag = String(label || 'VEHICLE').toUpperCase().replace(/[^A-Z0-9 .\-]/g, '').slice(0, 20).trim() || 'VEHICLE';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">'
      + '<rect width="120" height="80" fill="#0d1220"/>'
      + '<g fill="none" stroke="#4F8CFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M60 12c7 8 10 18 10 28v10l-10 7-10-7V40c0-10 3-20 10-28z"/>'
      + '<path d="M50 47l-8 9v-11M70 47l8 9v-11"/>'
      + '</g>'
      + '<text x="60" y="74" fill="#8C97AE" font-family="monospace" font-size="9" text-anchor="middle">' + tag + '</text>'
      + '</svg>');
  }
};
/* ---------- live streams: a clickable link for every launch ----------
   These are links rather than embeds, deliberately. A provider's broadcast is not running
   most of the time, and a frame pointed at a channel that is off air is a black rectangle
   with no explanation; their `/live` address instead takes the viewer to whatever is
   streaming right now, and to the channel itself when nothing is.

   Channel IDs, never handles: an ID survives a handle being renamed or re-registered, and
   that is not hypothetical — the handles this table replaced were checked and the faults
   were live (`@RocketLab`, `@northropgrumman` and `@JAXAchannel` all answered 404, and
   `@FireflyAerospace` resolved to an unrelated channel titled "Street View"). Every ID
   below was resolved from the organisation's own channel and confirmed by its title.
   Northrop Grumman and JAXA were absent from the first version of this table because
   neither could be verified then; both have since been checked and are listed. */
const LIVE_CHANNELS = {
  /* SpaceX is linked to the company's own site rather than YouTube: SpaceX runs its
     webcast on each mission page under /launches (the WATCH button), and /webcast itself
     serves only a page shell — the launch index is the address that always lands somewhere
     watchable. */
  'SpaceX':                 { site: 'https://www.spacex.com/launches', label: 'SpaceX' },
  'Rocket Lab':             { id: 'UCsWq7LZaizhIi-c-Yo_bcpw', label: 'Rocket Lab' },
  'United Launch Alliance': { id: 'UCnrGPRKAg1PgvuSHrRIl3jg', label: 'United Launch Alliance' },
  'ULA':                    { id: 'UCnrGPRKAg1PgvuSHrRIl3jg', label: 'ULA' },
  'Blue Origin':            { id: 'UCVxTHEKKLxNjGcvVaZindlg', label: 'Blue Origin' },
  'Arianespace':            { id: 'UCRn9F2D9j-t4A-HgudM7aLQ', label: 'Arianespace' },
  'ISRO':                   { id: 'UCw5hEVOTfz_AfzsNFWyNlNg', label: 'ISRO' },
  'Firefly Aerospace':      { id: 'UC31UF9oKANw77yxBLxN852A', label: 'Firefly Aerospace' },
  'JAXA':                   { id: 'UCfMIdADo6FQayQCOkLYGhrQ', label: 'JAXA' },
  'Northrop Grumman':       { id: 'UCiTTe3mBodoZVGVhQDpEFjg', label: 'Northrop Grumman' },
  'NASA':                   { id: 'UCLA_DiR1FfKNvjuUpBHmylQ', label: 'NASA' },
  'ESA':                    { id: 'UCIBaDdAbGlFDeS33shmlD0A', label: 'European Space Agency' }
};
function liveChannel(name){ return LIVE_CHANNELS[String(name || '').trim()] || null; }
/* where the click leads: providers with their own webcast pages go there, the rest to
   their YouTube /live address */
function liveHref(c){
  return c.site || ('https://www.youtube.com/channel/' + c.id + '/live');
}
function liveUrl(name){
  const c = liveChannel(name);
  return c ? liveHref(c) : '';
}
/* says what the click actually does, including the honest case where nothing is on air */
function liveTip(name){
  const c = liveChannel(name);
  if(!c) return '';
  return c.site
    ? 'Opens ' + c.label + '\u2019s launches page on their own site — pick the mission and use its WATCH button for the webcast'
    : 'Opens ' + c.label + '\u2019s live page on YouTube — the current broadcast if one is running, otherwise the channel itself';
}
function liveHost(c){ return c.site ? c.label : 'YouTube'; }
function liveLink(l){
  const c = liveChannel(l && l.agency);
  /* an empty span keeps the row's grid cell so the pad column does not shift */
  if(!c) return '<span></span>';
  return `<a class="live-link" href="${liveHref(c)}" target="_blank" rel="noopener noreferrer" title="${esc(liveTip(l.agency))}" aria-label="Open ${esc(c.label)} live stream on ${esc(liveHost(c))} (opens in a new tab)">▶ live stream ↗</a>`;
}
function liveKv(l){
  const c = liveChannel(l && l.agency);
  if(!c) return '';
  return `<div class="kv"><span class="k">LIVE STREAM</span><span class="v"><a class="live-link" href="${liveHref(c)}" target="_blank" rel="noopener noreferrer" title="${esc(liveTip(l.agency))}">▶ ${esc(c.label)} live ↗ on ${esc(liveHost(c))}</a></span></div>`;
}

function renderLaunches(){
  const q = $('launch-search').value.trim().toLowerCase();
  const statusFilter = $('launch-status').value;
  const agencyFilter = $('launch-agency').value;
  let filtered = allLaunches.filter(l => {
    const hay = (l.name + ' ' + l.agency + ' ' + l.rocket).toLowerCase();
    return (!q || hay.includes(q))
      && (statusFilter === 'all' || statusBucket(l.statusAbbrev) === statusFilter)
      && (agencyFilter === 'all' || l.agency === agencyFilter);
  });
  filtered.sort((a, b) => launchSortDesc ? b.dateObj - a.dateObj : a.dateObj - b.dateObj);
  $('launch-sort').textContent = 'sort: ' + (launchSortDesc ? 'latest ↓' : 'soonest ↑');
  $('launch-meta').textContent = `${filtered.length} of ${allLaunches.length} shown · global range`;

  const list = $('launch-list');
  if(filtered.length === 0){
    list.innerHTML = allLaunches.length
      ? '<div class="empty">No launches match the current filters.</div>'
      : '<div class="empty loading">waiting for the launch manifest…</div>';
    return;
  }
  const now = Date.now();
  list.innerHTML = filtered.map((l, i) => {
    const days = Math.max(0, (l.dateObj - now) / 86400000);
    const when = days < 1 ? 'today' : days < 2 ? 'tomorrow' : 'T–' + Math.floor(days) + 'd';
    /* the vehicle's own photograph when Launch Library publishes one, the themed placeholder
       otherwise — and, because it travels inside the name cell, a launch with no picture loses
       a thumbnail rather than shifting every cell after it */
    const thumb = l.rocketImage ? esc(l.rocketImage) : ROCKET_ART.ph(l.rocketFamily || l.rocket);
    return `
    <div class="row-item clickable" data-idx="${i}" role="button" tabindex="0" aria-label="Open the mission dossier for ${esc(l.name)}">
      <div class="date"><b>${l.dateDisplay}</b><br>${l.timeDisplay} · ${esc(when)}</div>
      <div class="row-main">
        <img class="thumb" src="${thumb}" alt="${esc(l.rocket)}" loading="lazy" />
        <div class="row-main-txt">
          <div class="name">${esc(l.name)}</div>
          <div class="sub">${esc(l.agency)} · ${esc(l.rocket)}</div>
          ${l.payload ? `<div class="sub pay"><span class="pay-k">payload</span>${esc(l.payload)}</div>` : ''}
        </div>
      </div>
      <span class="badge ${statusClass(l.statusAbbrev)}">${esc(l.statusName)}</span>
      ${liveLink(l)}
      <div class="pad">${esc(l.pad)}</div>
    </div>`;
  }).join('');
  /* The whole row is the control: clicking anywhere opens the dossier. */

  list.querySelectorAll('[data-idx]').forEach(el => {
    const open = () => MissionModal.open(filtered[Number(el.dataset.idx)]);
    el.addEventListener('click', e => {
      if(e.target.closest && e.target.closest('button, a')) return;
      open();
    });
    el.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); open(); } });
  });
}
let launchesFetchState = { tries: 0, timer: null, lastKey: null };
function cacheLaunches(){
  try{ Store.setJSON('vantage-launches', { t: Date.now(), items: allLaunches.map(l => ({ ...l, dateObj: l.dateObj.getTime() })) }); }catch(e){}
}
function restoreLaunches(){
  const c = Store.getJSON('vantage-launches', null);
  if(!c || !Array.isArray(c.items) || !c.items.length) return false;
  allLaunches = c.items.map(l => ({ ...l, dateObj: new Date(l.dateObj) })).filter(l => l.dateObj instanceof Date && !isNaN(l.dateObj));
  applyLaunchData();
  return true;
}
function applyLaunchData(){
  const agencies = [...new Set(allLaunches.map(l => l.agency))].sort();
  $('launch-agency').innerHTML = '<option value="all">All providers</option>' +
    agencies.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  $('badge-launches').textContent = allLaunches.length;
  $('tile-launch-count').textContent = allLaunches.length;
  const goN = allLaunches.filter(l => statusBucket(l.statusAbbrev) === 'go').length;
  $('tile-launch-sub').textContent = goN + ' currently "go"';
  renderLaunches();
  renderNextLaunchCard();
  Charts.buildMissions();
  buildBrief();
  Timeline.bump();          // launches are the timeline's spine, so it is told the moment they land
  Jellyfish.render();       // twilight windows are pure geometry — recomputed, never fetched
}
async function fetchLaunchesOnce(){
  // Launch Library 2 throttles aggressively on its free tier and can also simply hang — an
  // abort keeps the Missions view from sitting on "fetching…" indefinitely
  let res;
  try{
    res = await fetchWithTimeout('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=40', 12000);
  }catch(e){
    const err = new Error(e && e.name === 'AbortError' ? 'launch api timed out' : 'launch api unreachable');
    err.network = true;
    throw err;
  }
  if(res.status === 429 || res.status === 403){ const err = new Error('launch api throttled'); err.throttled = true; throw err; }
  if(!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json().catch(() => { const err = new Error('launch api returned invalid JSON'); err.network = true; throw err; });
  // throttles are sometimes reported in a 200 body rather than with a 429 status
  if(data && typeof data.detail === 'string' && /throttl|rate limit|exceed/i.test(data.detail)){
    const err = new Error('launch api throttled'); err.throttled = true; throw err;
  }
  return data;
}
function scheduleLaunchRetry(){
  if(launchesFetchState.timer) return;
  const delay = Math.min(5 * 60000, 15000 * Math.pow(2, launchesFetchState.tries)); // 15s → 30s → 60s … capped at 5min
  launchesFetchState.timer = setTimeout(() => { launchesFetchState.timer = null; loadLaunches(); }, delay);
}
async function loadLaunches(force){
  const key = (Range.start || '') + '|' + (Range.end || '');
  if(!force && key === launchesFetchState.lastKey && allLaunches.length){
    renderLaunches(); return; // same window — just re-filter what we have, don't re-fetch
  }
  const token = Seq.next('launches');
  try{
    const d = await fetchLaunchesOnce();
    if(Seq.isStale('launches', token)) return; // a newer window won — drop this response
    launchesFetchState.tries = 0;
    launchesFetchState.lastKey = key;
    const filtered = (Array.isArray(d.results) ? d.results : []).map(l => {
      const dt = new Date(l.net);
      const padStr = (typeof l.pad === 'string' && l.pad) || (l.pad && l.pad.name) || (l.pad && l.pad.location && l.pad.location.name) || '';
      const locStr = (typeof l.location === 'string' && l.location) || (l.pad && l.pad.location && l.pad.location.name) || '';
      return {
        name: l.name || 'Unnamed mission',
        agency: l.lsp_name || (l.launch_service_provider && l.launch_service_provider.name) || 'Unknown provider',
        rocket: (typeof l.rocket === 'string' && l.rocket)
          || (l.rocket && l.rocket.configuration && (l.rocket.configuration.full_name || l.rocket.configuration.name))
          || (l.name && l.name.includes(' | ') ? l.name.split(' | ')[0].trim() : '')
          || 'Unknown vehicle',
        pad: [padStr, locStr && locStr !== padStr ? locStr : ''].filter(Boolean).join(' · '),
        // pad coordinates, used to work out the Sun's elevation at lift-off for the
        // space-jellyfish window — LL2 returns these as strings, so they are parsed here
        padLat: num(l.pad && l.pad.latitude),
        padLon: num(l.pad && l.pad.longitude),
        launchId: l.id || '',
        // what is going up, and the vehicle picture the dossier and the manifest row paint
        payload: ll2PayloadName(l),
        payloadType: (l.mission && l.mission.type) || '',
        rocketImage: ll2RocketImage(l),
        rocketFamily: (l.rocket && l.rocket.configuration && (l.rocket.configuration.family || l.rocket.configuration.name)) || '',
        statusAbbrev: (l.status && l.status.abbrev) || 'TBD',
        statusName: (l.status && l.status.name) || 'To be determined',
        dateDisplay: launchDateLabel(dt),
        timeDisplay: dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
        dateObj: dt
      };
    }).filter(l => inRange(l.dateObj.getTime()));
    if(!filtered.length && allLaunches.length && force !== true){
      // throttle responses often return an empty/trimmed list — keep showing what we had
      renderLaunches();
      return;
    }
    allLaunches = filtered;
    cacheLaunches();
    applyLaunchData();
  }catch(e){
    if(Seq.isStale('launches', token)) return;
    launchesFetchState.tries++;
    if(allLaunches.length){
      // keep the last good manifest on screen — never blank the view
      if(e && e.throttled && force) $('launch-meta').textContent = 'cached manifest · live feed throttled';
      renderLaunches();
    } else if(restoreLaunches()){
      $('launch-meta').innerHTML = 'cached manifest' + SampleData.badge('cached')
        + Retry.register('launches', () => loadLaunches(true)).btn('launches');
    } else {
      // last resort: representative sample manifest — badged, filters and charts fully functional
      const sample = SampleData.launches();
      const inWindow = sample.filter(l => inRange(l.dateObj.getTime()));
      allLaunches = inWindow.length ? inWindow : sample; // never show an empty sample window
      launchesFetchState.lastKey = null; // allow a live overwrite on the next successful fetch
      applyLaunchData();
      $('launch-meta').innerHTML = 'sample manifest · live feed unreachable' + SampleData.badge('sample')
        + Retry.register('launches', () => loadLaunches(true)).btn('launches');
    }
    scheduleLaunchRetry();
  }
}
function renderNextLaunchCard(){
  const el = $('next-launch-card');
  if(allLaunches.length === 0){ el.innerHTML = '<div class="empty">No launches inside the current range.</div>'; return; }
  const l = allLaunches[0];
  const days = Math.max(0, Math.round((l.dateObj - Date.now()) / 86400000));
  el.innerHTML = `
    <div style="font-size:17px;font-weight:600">${esc(l.name)}</div>
    <div style="font-size:12.5px;color:var(--text-2);margin:4px 0 12px">${esc(l.agency)} · ${esc(l.rocket)} · ${esc(l.pad)}</div>
    ${l.payload ? `<div class="kv"><span class="k">PAYLOAD</span><span class="v">${esc(l.payload)}</span></div>` : ''}
    <div class="kv"><span class="k">LIFTOFF</span><span class="v">${l.dateDisplay} ${l.timeDisplay}</span></div>
    <div class="kv"><span class="k">COUNTDOWN</span><span class="v">T–${days} day${days === 1 ? '' : 's'}</span></div>
    <div class="kv"><span class="k">STATUS</span><span class="v">${esc(l.statusName)}</span></div>
    ${liveKv(l)}
    `;
}
['launch-search', 'launch-status', 'launch-agency'].forEach(id => {
  $(id).addEventListener(id === 'launch-search' ? 'input' : 'change', renderLaunches);
});
$('launch-sort').addEventListener('click', () => { launchSortDesc = !launchSortDesc; renderLaunches(); });

export { loadLaunches, statusClass, statusBucket, liveKv, launchDateLabel, renderLaunches };
export function allLaunchesOf(){ return allLaunches; }
