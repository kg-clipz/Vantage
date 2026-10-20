/* ================================================================
   Vantage — js/modules/geotools.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */

import { $, Store, httpJSON, esc, fmt, num, isoDate } from '../api.js';
/* ================================================================
   Coordinate → location mapper
   Answers "what is under this point" for the ISS ground track and
   for EONET markers. Deliberately coarse: a box table (most
   specific first) plus a landmark list for the "<n> km SW of X"
   detail. Not GIS-grade — it reads a point at a glance.
   ================================================================ */
const GeoTools = {
  REGIONS: [
    { n: 'Antarctica',            k: 'land',  b: [-180, -90,  180, -63] },
    { n: 'Greenland',             k: 'land',  b: [ -74,  59,  -11,  84] },
    { n: 'Australia',             k: 'land',  b: [ 112, -44,  154, -10] },
    { n: 'New Zealand',           k: 'land',  b: [ 165, -48,  179, -34] },
    { n: 'Madagascar',            k: 'land',  b: [  43, -26,   51, -12] },
    { n: 'Japan',                 k: 'land',  b: [ 129,  30,  146,  46] },
    { n: 'Iceland',               k: 'land',  b: [ -25,  62,  -13,  67] },
    { n: 'the British Isles',     k: 'land',  b: [ -11,  49,    2,  61] },
    { n: 'Africa',                k: 'land',  b: [ -18, -35,   52,  37] },
    /* North America is split rather than one generous box: a single [-168,15,-52,72]
       rectangle swallows the whole eastern Pacific, so a storm at 20°N/142°W reads as
       "North America". Tighter boxes let the ocean fall through to the ocean layer. */
    { n: 'Canada & Alaska',       k: 'land',  b: [-168,  49,  -52,  72] },
    { n: 'the United States',     k: 'land',  b: [-125,  25,  -67,  49] },
    { n: 'Mexico',                k: 'land',  b: [-112,  14,  -86,  33] },
    { n: 'Central America',       k: 'land',  b: [ -93,   7,  -77,  18] },
    { n: 'South America',         k: 'land',  b: [ -82, -56,  -34,  13] },
    { n: 'the Caribbean',         k: 'land',  b: [ -85,   9,  -59,  27] },
    { n: 'Europe',                k: 'land',  b: [ -25,  35,   45,  72] },
    { n: 'the Middle East',       k: 'land',  b: [  34,  12,   63,  40] },
    { n: 'Southeast Asia',        k: 'land',  b: [  95,  10,  141,  23] },
    { n: 'Indonesia & New Guinea', k: 'land', b: [  95, -11,  151,   6] },
    { n: 'Asia',                  k: 'land',  b: [  45,   5,  180,  78] },
    { n: 'the Southern Ocean',    k: 'ocean', b: [-180, -63,  180, -45] },
    { n: 'the Arctic Ocean',      k: 'ocean', b: [-180,  66,  180,  90] },
    { n: 'the Indian Ocean',      k: 'ocean', b: [  20, -45,  147,  30] },
    { n: 'the North Pacific',     k: 'ocean', b: [-180,   0,  -80,  62] },
    { n: 'the South Pacific',     k: 'ocean', b: [-180, -45,  -70,   0] },
    { n: 'the North Atlantic',    k: 'ocean', b: [ -80,   0,   20,  66] },
    { n: 'the South Atlantic',    k: 'ocean', b: [ -70, -45,   25,   0] }
  ],
  LANDMARKS: [
    { p: 'Honolulu',       lat:  21.31, lon: -157.86 },
    { p: 'Anchorage',      lat:  61.22, lon: -149.90 },
    { p: 'Los Angeles',    lat:  34.05, lon: -118.24 },
    { p: 'Houston',        lat:  29.76, lon:  -95.37 },
    { p: 'New York',       lat:  40.71, lon:  -74.01 },
    { p: 'Mexico City',    lat:  19.43, lon:  -99.13 },
    { p: 'Bogotá',         lat:   4.71, lon:  -74.07 },
    { p: 'Lima',           lat: -12.05, lon:  -77.04 },
    { p: 'São Paulo',      lat: -23.55, lon:  -46.63 },
    { p: 'Buenos Aires',   lat: -34.60, lon:  -58.38 },
    { p: 'Punta Arenas',   lat: -53.16, lon:  -70.91 },
    { p: 'Reykjavík',      lat:  64.15, lon:  -21.94 },
    { p: 'London',         lat:  51.51, lon:   -0.13 },
    { p: 'Paris',          lat:  48.86, lon:    2.35 },
    { p: 'Madrid',         lat:  40.42, lon:   -3.70 },
    { p: 'Berlin',         lat:  52.52, lon:   13.40 },
    { p: 'Moscow',         lat:  55.76, lon:   37.62 },
    { p: 'Cairo',          lat:  30.04, lon:   31.24 },
    { p: 'Lagos',          lat:   6.52, lon:    3.38 },
    { p: 'Nairobi',        lat:  -1.29, lon:   36.82 },
    { p: 'Cape Town',      lat: -33.92, lon:   18.42 },
    { p: 'Dubai',          lat:  25.20, lon:   55.27 },
    { p: 'Mumbai',         lat:  19.08, lon:   72.88 },
    { p: 'Colombo',        lat:   6.93, lon:   79.86 },
    { p: 'Jakarta',        lat:  -6.21, lon:  106.85 },
    { p: 'Singapore',      lat:   1.35, lon:  103.82 },
    { p: 'Hong Kong',      lat:  22.32, lon:  114.17 },
    { p: 'Tokyo',          lat:  35.68, lon:  139.69 },
    { p: 'Seoul',          lat:  37.57, lon:  126.98 },
    { p: 'Sydney',         lat: -33.87, lon:  151.21 },
    { p: 'Perth',          lat: -31.95, lon:  115.86 },
    { p: 'Auckland',       lat: -36.85, lon:  174.76 },
    { p: 'Suva, Fiji',     lat: -18.14, lon:  178.44 },
    { p: 'McMurdo Station', lat: -77.85, lon: 166.67 }
  ],
  rad(d){ return d * Math.PI / 180; },
  haversine(lat1, lon1, lat2, lon2){
    const R = 6371, dLat = this.rad(lat2 - lat1), dLon = this.rad(lon2 - lon1);
    const h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(this.rad(lat1)) * Math.cos(this.rad(lat2)) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  },
  bearing(lat1, lon1, lat2, lon2){
    const y = Math.sin(this.rad(lon2 - lon1)) * Math.cos(this.rad(lat2));
    const x = Math.cos(this.rad(lat1)) * Math.sin(this.rad(lat2)) - Math.sin(this.rad(lat1)) * Math.cos(this.rad(lat2)) * Math.cos(this.rad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  },
  compass(deg){
    const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return pts[Math.round((deg % 360) / 22.5) % 16];
  },
  region(lat, lon){
    return this.REGIONS.find(r => lat >= r.b[1] && lat <= r.b[3] && lon >= r.b[0] && lon <= r.b[2]) || null;
  },
  nearest(lat, lon){
    let best = null;
    for(const p of this.LANDMARKS){
      const km = this.haversine(lat, lon, p.lat, p.lon);
      if(!best || km < best.km) best = { p: p.p, km: km, brg: this.bearing(lat, lon, p.lat, p.lon) };
    }
    if(best) best.dir = this.compass(best.brg + 180); // direction from the landmark back to the point
    return best;
  },
  describe(lat, lon){
    if(!isFinite(lat) || !isFinite(lon)) return null;
    const r = this.region(lat, lon);
    return { area: r ? r.n : 'the open ocean', kind: r ? r.k : 'ocean', nearest: this.nearest(lat, lon) };
  },
  /* one-line human answer, used by the ISS telemetry panel */
  line(lat, lon){
    const d = this.describe(lat, lon);
    if(!d) return 'unknown';
    const km = d.nearest ? Math.round(d.nearest.km / 10) * 10 : null;
    const near = (d.nearest && km > 20) ? ` — approx. ${fmt(km, 0)} km ${d.nearest.dir} of ${d.nearest.p}` : (d.nearest ? ` — right over ${d.nearest.p}` : '');
    return `over ${d.area}${near}`;
  },
  short(lat, lon){
    const d = this.describe(lat, lon);
    return d ? d.area : 'unknown region';
  }
};

export { GeoTools };
