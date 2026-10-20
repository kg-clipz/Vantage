import { currentApodOf } from './apod.js';
import { marsPhotosOf } from './rovers.js';
import { marsRoverOf } from './rovers.js';
import { allNeosOf } from './asteroids.js'
import { lastIssOf } from './iss.js'
import { Range } from '../ui.js'
import { allLaunchesOf, statusBucket } from './missions.js'
/* ================================================================
   Vantage — js/modules/brief.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */

import { $, Store, httpJSON, esc, fmt, num, isoDate } from '../api.js';
/* ================================================================
   Analysis write-ups
   ================================================================ */
function buildBrief(){
  const brief = $('brief');
  const cards = {};
  // --- orbital mechanics ---
  if(lastIssOf()){
    const Re = 6371, mu = 398600.4418;
    const a = Re + lastIssOf().altitude;
    const periodMin = 2 * Math.PI * Math.sqrt(Math.pow(a, 3) / mu) / 60;
    const vCirc = Math.sqrt(mu / a); // km/s
    const maxBetaAngle = Math.asin(Math.min(1, (6371 * Math.cos(23.44 * Math.PI / 180)) / a)) * 180 / Math.PI;
    cards.orbital = `
      <div class="brief-card">
        <h4><span class="k">ORBITAL</span> International Space Station</h4>
        <p>The station is passing near <strong>${lastIssOf().latitude.toFixed(1)}°, ${lastIssOf().longitude.toFixed(1)}°</strong> at an altitude of <span class="mono">${Math.round(lastIssOf().altitude)} km</span> and <span class="mono">${Math.round(lastIssOf().velocity).toLocaleString()} km/h</span>.</p>
        <p>From its semi-major axis of <span class="mono">${Math.round(a)} km</span>, Kepler's third law gives an orbital period of <span class="mono">${periodMin.toFixed(1)} min</span> — about <span class="mono">${(1440 / periodMin).toFixed(1)}</span> orbits per day. The speed implied by a circular orbit at this altitude is <span class="mono">${Math.round(vCirc * 3600).toLocaleString()} km/h</span>, so the reported velocity sits within a few percent of circular: a near-circular, low-drag trajectory.</p>
        <p>Its 51.6° inclination means the ground track sweeps between ${(-51.6).toFixed(1)}° and 51.6° latitude, and the solar beta angle can climb toward <span class="mono">${maxBetaAngle.toFixed(0)}°</span> at the solstices — driving the eclipse seasons that shape station power planning. Atmospheric drag at this altitude bleeds a few hundred metres of height per month, so the orbit is re-boosted regularly.</p>
        <div class="kv"><span class="k">SEMI-MAJOR AXIS</span><span class="v">${fmt(a, 0)} km</span></div>
        <div class="kv"><span class="k">ORBITAL PERIOD</span><span class="v">${periodMin.toFixed(1)} min</span></div>
        <div class="kv"><span class="k">ORBITS / DAY</span><span class="v">${(1440 / periodMin).toFixed(2)}</span></div>
        <div class="kv"><span class="k">VISIBILITY</span><span class="v">${lastIssOf().visibility === 'daylight' ? 'sunlit' : 'eclipse'}</span></div>
      </div>`;
  }
  // --- manifest reliability ---
  if(allLaunchesOf().length){
    const go = allLaunchesOf().filter(l => statusBucket(l.statusAbbrev) === 'go');
    const tbd = allLaunchesOf().filter(l => statusBucket(l.statusAbbrev) === 'tbd');
    const hold = allLaunchesOf().length - go.length - tbd.length;
    const pct = n => allLaunchesOf().length ? Math.round(n / allLaunchesOf().length * 100) : 0;
    const byProv = {};
    allLaunchesOf().forEach(l => {
      byProv[l.agency] = byProv[l.agency] || { total: 0, go: 0 };
      byProv[l.agency].total++;
      if(statusBucket(l.statusAbbrev) === 'go') byProv[l.agency].go++;
    });
    const ranked = Object.entries(byProv).sort((a, b) => (b[1].go / b[1].total) - (a[1].go / a[1].total));
    const busiest = Object.entries(byProv).sort((a, b) => b[1].total - a[1].total)[0];
    const next = allLaunchesOf()[0];
    cards.manifest = `
      <div class="brief-card">
        <h4><span class="k">MANIFEST</span> Launch reliability</h4>
        <p>Across <strong>${allLaunchesOf().length}</strong> upcoming launches in the current range, <strong>${go.length} (${pct(go.length)}%)</strong> carry a confirmed "go" status, <strong>${tbd.length} (${pct(tbd.length)}%)</strong> remain TBD, and <strong>${hold}</strong> are on hold or otherwise constrained. A high TBD share this far out is normal — providers lock statuses inside the final week.</p>
        ${ranked.slice(0, 3).map(([p, s]) => `<div class="kv"><span class="k">${esc(p.toUpperCase())}</span><span class="v">${s.go}/${s.total} go (${pct(s.go / s.total * 100) === 0 && s.go === 0 ? 0 : Math.round(s.go / s.total * 100)}%)</span></div>`).join('')}
        <p style="margin-top:10px">${busiest ? `<strong>${esc(busiest[0])}</strong> leads the manifest with ${busiest[1].total} missions; ` : ''}${next ? `the next liftoff is <strong>${esc(next.name)}</strong> in about <span class="mono">${Math.max(0, Math.round((next.dateObj - Date.now()) / 86400000))} days</span>.` : ''}</p>
      </div>`;
  }
  // --- planetary defense ---
  if(allNeosOf().length){
    const hz = allNeosOf().filter(r => r.hazardous);
    const closest = allNeosOf().reduce((best, r) => Number.isFinite(r.missLunar) && (!best || r.missLunar < best.missLunar) ? r : best, null);
    const fastest = allNeosOf().reduce((best, r) => Number.isFinite(r.vel) && (!best || r.vel > best.vel) ? r : best, null);
    const moonKm = 384400;
    cards.neo = `
      <div class="brief-card">
        <h4><span class="k">PLANETARY DEFENSE</span> Near-Earth objects</h4>
        <p>The feed lists <strong>${allNeosOf().length}</strong> approaches in range${hz.length ? `, of which <strong>${hz.length}</strong> carry NASA's "potentially hazardous" flag` : ' — none flagged hazardous in this window'}. That flag combines size (>~140 m) with an orbit that can pass within ~0.05 AU, not an impact prediction.</p>
        ${closest ? `<p>The closest is <strong>${esc(closest.name)}</strong>, passing at <span class="mono">${fmt(closest.missLunar, 1)}</span> lunar distances${Number.isFinite(closest.missKm) ? ` (≈ <span class="mono">${fmt(closest.missKm / moonKm, 1)}</span> Moon-widths)` : ''}.${fastest ? ` Fastest of the set: <strong>${esc(fastest.name)}</strong> at <span class="mono">${fmt(fastest.vel, 1)} km/s</span> — over twenty times faster than a rifle round.` : ''}</p>` : '<p>None of this window\'s objects came back with a close-approach distance, so nothing can be ranked.</p>'}
        <div class="kv"><span class="k">WINDOW</span><span class="v">${Range.start || 'today'} → ${Range.end || '—'}</span></div>
        <div class="kv"><span class="k">HAZARDOUS FLAGGED</span><span class="v">${hz.length}</span></div>
        <div class="kv"><span class="k">CLOSEST PASS</span><span class="v">${closest ? fmt(closest.missLunar, 1) + ' LD' : '—'}</span></div>
      </div>`;
  }
  // --- mars ops ---
  cards.mars = `
    <div class="brief-card">
      <h4><span class="k">MARS OPS</span> Rover status</h4>
      <p>Browsing <strong>${marsRoverOf().name}</strong>, operating on Mars since ${String(marsRoverOf()).toLowerCase() === 'curiosity' ? 'August 2012 in Gale Crater' : 'February 2021 in Jezero Crater'}. A sol runs 24 h 39 m 35 s, so rover clocks drift about 40 minutes per day against yours.</p>
      <div class="kv"><span class="k">PHOTOS IN CURRENT QUERY</span><span class="v">${marsPhotosOf().length}</span></div>
      <div class="kv"><span class="k">ACTIVE ROVER FLEET</span><span class="v">Curiosity · Perseverance</span></div>
      <p style="margin-top:10px">Curiosity (MSL) has climbed Mount Sharp for over a decade; Perseverance is caching samples in Jezero's ancient river delta for future return. The feed here is raw JPGs, straight from the cameras.</p>
    </div>`;
  // --- apod ---
  if(currentApodOf()){
    cards.apod = `
      <div class="brief-card">
        <h4><span class="k">SKY</span> Tonight's picture</h4>
        <p>Featured for ${currentApodOf().date}: <strong>${esc(currentApodOf().title)}</strong>. ${currentApodOf().explanation ? esc(currentApodOf().explanation.slice(0, 260)) + (currentApodOf().explanation.length > 260 ? '…' : '') : ''}</p>
        <p>${currentApodOf().copyright ? `Image credit: ${esc(currentApodOf().copyright)}. ` : ''}${isBookmarked() ? 'You have bookmarked this one.' : ''}</p>
      </div>`;
  }
  const order = ['orbital', 'manifest', 'neo', 'mars', 'apod'];
  order.forEach(k => {
    if(cards[k]){
      const old = brief.querySelector(`.brief-card:nth-of-type(${order.indexOf(k) + 1})`);
      if(old) old.outerHTML = cards[k];
    }
  });
}

export { buildBrief };

export function buildBriefPublic(){ return buildBrief(); }
