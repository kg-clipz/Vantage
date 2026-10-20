import { toast } from './ui.js';
/* ================================================================
   Vantage — js/audio.js
   Extracted verbatim from the mission-console monolith; original
   section comments preserved. Imports/exports added by tooling.
   ================================================================ */

import { $, Store, httpJSON, esc, fmt, num, isoDate } from './api.js';
/* ================================================================
   Ambient space audio — synthesised in the browser, not streamed
   Seven slowly detuned oscillators through a breathing lowpass and
   a feedback delay, plus occasional bell tones. Because it is built
   with the Web Audio API there is no audio file to fetch, nothing to
   buffer, and nothing to license — it even works offline.
   ================================================================ */
/* ================================================================
   Audio alert system — synthesised, no files
   A short bell built from oscillators, so there is nothing to host,
   load or license. Alerting is opt-in (autoplay policy requires a
   gesture anyway), and enabling it *seeds* the current activity as
   already-announced so switching it on never replays yesterday's
   space weather at the viewer.
   ================================================================ */
const Chime = {
  ON_KEY: 'vantage-alerts-on',
  on: false, ctx: null, master: null, seen: {},
  init(){
    this.on = Store.get(this.ON_KEY, '0') === '1';
    this.paint();
  },
  ensure(){
    if(this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    const ctx = this.ctx = new AC();
    const master = this.master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    return ctx;
  },
  /* a clean two-tone bell: an octave stack rather than a single beep, which carries much
     better over whatever else is playing */
  play(kind){
    if(!this.on) return false;
    const ctx = this.ensure();
    if(!ctx) return false;
    if(ctx.resume && ctx.state !== 'running'){ try{ ctx.resume(); }catch(e){} }
    const notes = kind === 'crit' ? [[1174.66, 0], [1567.98, 0.16], [2349.32, 0.32]]
      : kind === 'warn' ? [[880.00, 0], [1318.51, 0.15]]
      : [[659.25, 0]];
    const peak = kind === 'crit' ? 0.16 : kind === 'warn' ? 0.12 : 0.07;
    const t0 = ctx.currentTime;
    notes.forEach(n => {
      const f = n[0], t = t0 + n[1];
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.014);     // a real attack, not a click
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + 0.85);
    });
    return true;
  },
  /* fire at most once per upstream event id, ever */
  once(id){ if(this.seen[id]) return false; this.seen[id] = Date.now(); return true; },
  recent(iso, days){
    const t = Date.parse(iso);
    if(!isFinite(t)) return false;
    const age = (Date.now() - t) / 86400000;
    return age >= -0.25 && age <= days;
  },
  /* ---- triggers ---- */
  checkSpaceWeather(events){
    if(!this.on || (typeof Donki !== 'undefined' && Donki.usingSample)) return;
    const flares = (events || []).filter(e => e.kind === 'FLR');
    const strongest = flares.slice().sort((a, b) => this.rank(b) - this.rank(a))[0];
    if(strongest){
      const r = Donki.rank(strongest.cls);
      if((r === 'X' || r === 'M') && this.recent(strongest.time, 2) && this.once('flr:' + strongest.id)){
        this.play(r === 'X' ? 'crit' : 'warn');
        toast(`${r}-class solar flare · ${strongest.cls}${strongest.loc ? ' at ' + strongest.loc : ''}`);
      }
    }
    const storms = (events || []).filter(e => e.kind === 'GST');
    const worst = storms.slice().sort((a, b) => (b.kp || 0) - (a.kp || 0))[0];
    if(worst && (worst.kp || 0) >= 7 && this.recent(worst.time, 3) && this.once('gst:' + worst.id)){
      this.play(worst.kp >= 8 ? 'crit' : 'warn');
      toast(`Geomagnetic storm at Kp ${worst.kp} · aurora may be visible far from the poles`);
    }
  },
  /* EONET carries no severity field, so the trigger is deliberately narrow and stated as
     what it is: the largest reported magnitude in a hazard category, reported recently. */
  checkEvents(list){
    if(!this.on || (typeof Eonet === 'undefined' || Eonet.isSample || Eonet.isCached)) return;
    const hazards = ['wildfires', 'severeStorms', 'volcanoes', 'floods'];
    (list || []).forEach(ev => {
      const cat = Eonet.catId(ev);
      if(hazards.indexOf(cat) < 0) return;
      const g = Eonet.latest(ev);
      if(!g || g.magnitudeValue == null) return;
      const top = Eonet.scale[cat];
      if(!top) return;
      if(num(g.magnitudeValue) < top * 0.9) return;         // only the category's biggest
      if(!this.recent(g.date, 3)) return;                    // and only genuinely new ones
      if(!this.once('eonet:' + ev.id)) return;
      const label = Eonet.cat(cat).l;
      this.play('warn');
      toast(`Severe ${label.toLowerCase()} event · ${ev.title} (${fmt(g.magnitudeValue, 0)} ${g.magnitudeUnit || ''})`.trim());
    });
  },
  rank(f){ return ((Donki.RANKS[Donki.rank(f.cls)] || 0) * 100) + Donki.size(f.cls); },
  /* enabling alerts must not replay history the viewer has already looked at */
  seed(){
    if(typeof Donki !== 'undefined' && !Donki.usingSample){
      Donki.events.forEach(e => { this.seen[(e.kind === 'GST' ? 'gst:' : 'flr:') + e.id] = Date.now(); });
    }
    if(typeof Eonet !== 'undefined' && !Eonet.isSample){
      Eonet.events.forEach(e => { this.seen['eonet:' + e.id] = Date.now(); });
    }
  },
  toggle(){
    const next = !this.on;
    this.on = next;
    Store.set(this.ON_KEY, next ? '1' : '0');
    if(next){
      const ctx = this.ensure();
      if(!ctx){ this.on = false; Store.set(this.ON_KEY, '0'); this.paint(); toast('This browser cannot synthesise audio (no Web Audio API)'); return; }
      if(ctx.resume && ctx.state !== 'running'){ try{ ctx.resume(); }catch(e){} }
      this.seed();
      this.play('info');       // audible proof that the toggle actually works
      toast('Audio alerts on — X-class flares and severe events will chime');
    } else {
      toast('Audio alerts off');
    }
    this.paint();
  },
  paint(){
    const b = $('alertToggle');
    if(!b) return;
    b.textContent = this.on ? '🔔' : '🔕';
    b.setAttribute('aria-pressed', String(this.on));
    b.classList.toggle('on', this.on);
  }
};

const Ambient = {
  ctx: null, master: null, bus: null, lfo: null, voices: [], bellTimer: null, playing: false,
  /* incrementing this invalidates any fade-out still in flight, so a quick off→on toggle
     cannot be cut short by the previous stop()'s teardown */
  gen: 0,
  vol: Number(Store.get('vantage-ambient-vol', '45')) || 45,
  /* open fifths and octaves — that interval stack is what gives a handpan its calm,
     unresolved character rather than sounding like a chord */
  VOICES: [
    { f: 110.00, g: 0.30 }, { f: 196.00, g: 0.16 }, { f: 220.00, g: 0.20 },
    { f: 261.63, g: 0.14 }, { f: 329.63, g: 0.12 }, { f: 440.00, g: 0.06 }, { f: 164.81, g: 0.18 }
  ],
  BELLS: [523.25, 587.33, 659.25, 783.99, 880.00, 1174.66],
  init(){
    if(this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return false;
    const ctx = this.ctx = new AC();
    const master = this.master = ctx.createGain();
    master.gain.value = 0.0001;
    master.connect(ctx.destination);
    // a lowpass plus feedback delay gives the sense of a large, empty space
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.4;
    const delay = ctx.createDelay(2.0); delay.delayTime.value = 0.42;
    const fb = ctx.createGain(); fb.gain.value = 0.36;
    const wet = ctx.createGain(); wet.gain.value = 0.34;
    lp.connect(master);
    lp.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);
    this.bus = lp;
    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
    lfo.frequency.value = 0.035; lfoGain.gain.value = 320;
    lfo.connect(lfoGain); lfoGain.connect(lp.frequency); lfo.start();
    this.lfo = lfo;
    return true;
  },
  /* The voices are built separately from the graph so they can be stopped and rebuilt per
     session. Stopping an oscillator is the only way to be certain it is silent — and that
     is exactly what clicks if it happens while the voice is still audible, which is why it
     only ever happens after the master gain has ramped to the floor. */
  buildVoices(){
    if(!this.ctx || this.voices.length) return;
    const ctx = this.ctx, lp = this.bus;
    this.VOICES.forEach((v, i) => {
      const osc = ctx.createOscillator();
      osc.type = i % 2 ? 'sine' : 'triangle';
      osc.frequency.value = v.f;
      osc.detune.value = (i - 3) * 4;                 // a few cents of spread beats gently
      const g = ctx.createGain();
      g.gain.value = v.g;
      const amp = ctx.createOscillator(), ampGain = ctx.createGain();
      amp.frequency.value = 0.03 + i * 0.011;          // every voice breathes at its own rate
      ampGain.gain.value = v.g * 0.5;
      amp.connect(ampGain); ampGain.connect(g.gain); amp.start();
      osc.connect(g); g.connect(lp); osc.start();
      this.voices.push({ osc: osc, amp: amp, g: g, ampGain: ampGain });
    });
  },
  teardownVoices(){
    const stop = n => { try{ n.stop(); }catch(e){} };
    const cut = n => { try{ n.disconnect(); }catch(e){} };
    this.voices.forEach(v => { stop(v.osc); stop(v.amp); cut(v.osc); cut(v.amp); cut(v.g); cut(v.ampGain); });
    this.voices = [];
  },
  /* A parameter under automation cannot simply be rescheduled: cancelScheduledValues makes
     it snap back to its pre-ramp value, and that snap *is* the click. cancelAndHoldAtTime
     pins it wherever the ramp had actually reached, which every ramp below depends on. */
  hold(param, t){
    if(typeof param.cancelAndHoldAtTime === 'function'){
      try{ param.cancelAndHoldAtTime(t); return; }catch(e){}
    }
    const v = Math.max(0.0001, param.value);
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  },
  /* perceptual-ish taper — a linear gain slider feels dead at the quiet end */
  gain(){ return Math.pow(this.vol / 100, 1.7) * 0.5; },
  bell(){
    if(!this.ctx || !this.bus) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const f = this.BELLS[Math.floor(Math.random() * this.BELLS.length)];
    const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 4.5);
    osc.connect(g); g.connect(this.bus);
    osc.start(t); osc.stop(t + 5);
  },
  scheduleBell(){
    clearTimeout(this.bellTimer);
    this.bellTimer = setTimeout(() => {
      if(!this.playing) return;
      this.bell();
      this.scheduleBell();
    }, 7000 + Math.random() * 9000);
  },
  start(){
    if(this.playing) return;
    if(!this.init()){ toast('This browser cannot synthesise audio (no Web Audio API)'); return; }
    this.gen++;                       // cancels any pending teardown from a previous stop()
    const ctx = this.ctx;
    /* a context that was suspended by stop() has to be resumed before its clock advances,
       and resume() is asynchronous — the ramp below is scheduled against that clock either
       way, it simply begins once the context is running again */
    if(ctx.resume && ctx.state !== 'running'){ try{ ctx.resume(); }catch(e){} }
    this.buildVoices();
    const t = ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.exponentialRampToValueAtTime(Math.max(0.0001, this.gain()), t + 2.6);  // fade in, never a click
    this.playing = true;
    Store.set('vantage-ambient', '1');
    this.scheduleBell();
    this.paint();
  },
  stop(){
    this.gen++;
    const token = this.gen;
    clearTimeout(this.bellTimer);
    this.playing = false;
    Store.set('vantage-ambient', '0');
    this.paint();
    if(!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = this.master.gain;
    this.hold(g, t);
    /* An exponential ramp cannot reach zero, so 0.0001 is the practical floor — and unlike
       linear it sounds like a fade rather than a step, which is what removes the pop. */
    try{ g.exponentialRampToValueAtTime(0.0001, t + 0.3); }
    catch(e){ g.linearRampToValueAtTime(0.0001, t + 0.3); }
    /* the oscillators are stopped — and the context suspended — only once the fade has
       finished, and only if no restart has happened in the meantime */
    setTimeout(() => {
      if(token !== this.gen || this.playing) return;
      this.teardownVoices();
      if(this.ctx && this.ctx.suspend){ try{ this.ctx.suspend(); }catch(e){} }
    }, 360);
  },
  toggle(){ this.playing ? this.stop() : this.start(); },
  setVolume(v){
    this.vol = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    Store.set('vantage-ambient-vol', String(this.vol));
    if(this.ctx && this.playing){
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.gain(), t, 0.08);
    }
    this.paint();
  },
  paint(){
    const btn = $('audioToggle');
    if(!btn) return;
    btn.textContent = this.playing ? '♫' : '♪';
    btn.classList.toggle('on', this.playing);
    btn.setAttribute('aria-pressed', this.playing ? 'true' : 'false');
    $('audioEq').classList.toggle('on', this.playing);
    $('audioVol').value = String(this.vol);
    $('audioPct').textContent = this.vol + '%';
    $('audioStop').textContent = this.playing ? 'stop' : 'start';   // the panel button is the switch
  },
  /* browsers refuse audio until the user interacts, so a remembered "on" is resumed on the
     first gesture anywhere rather than being silently forgotten */
  armResume(){
    this.paint();
    if(Store.get('vantage-ambient', '0') !== '1') return;
    const go = () => {
      document.removeEventListener('pointerdown', go);
      document.removeEventListener('keydown', go);
      if(!this.playing) this.start();
    };
    document.addEventListener('pointerdown', go, { once: true });
    document.addEventListener('keydown', go, { once: true });
  }
};

/* ================================================================
   Mission audio — real public streams, and a feed you can paste in
   ================================================================ */
const Comms = {
  /* These are the station's own published stream addresses (taken from SomaFM's .pls playlists)
     and every one of them was verified to answer audio/mpeg before being listed. The mp3
     variants lead because raw ADTS/AAC in an <audio> element is not universally supported. */
  STREAMS: [
    { id: 'mc', name: 'Mission Control', sub: 'space-themed · SomaFM', page: 'https://somafm.com/missioncontrol/',
      urls: ['https://ice6.somafm.com/missioncontrol-128-mp3', 'https://ice2.somafm.com/missioncontrol-128-mp3', 'https://ice5.somafm.com/missioncontrol-128-mp3'] },
    { id: 'ds', name: 'Deep Space One', sub: 'deep ambient · SomaFM', page: 'https://somafm.com/deepspaceone/',
      urls: ['https://ice6.somafm.com/deepspaceone-128-mp3', 'https://ice4.somafm.com/deepspaceone-128-mp3', 'https://ice2.somafm.com/deepspaceone-128-mp3'] }
  ],
  VOL_KEY: 'vantage-comms-vol',
  URL_KEY: 'vantage-comms-url',
  el: null, cur: null, urlIndex: 0, vol: Number(Store.get('vantage-comms-vol', '70')) || 70,
  wired: false, watch: null,
  /* Hosts that answer with an HTML page rather than audio. Pointing an <audio> element at one
     of these fails with a bare "not supported" that explains nothing, and pasting a media-service or
     Spotify share link is by far the most common mistake here — so they are named up front. */
  PAGE_HOSTS: [
    ['spotify.com', 'Spotify'], ['soundcloud.com', 'SoundCloud'], ['twitch.tv', 'Twitch'],
    ['vimeo.com', 'Vimeo'], ['mixcloud.com', 'Mixcloud'], ['bandcamp.com', 'Bandcamp'],
    ['facebook.com', 'Facebook'], ['instagram.com', 'Instagram'], ['tiktok.com', 'TikTok'],
    ['x.com', 'X'], ['twitter.com', 'X'], ['dailymotion.com', 'Dailymotion'],
    ['deezer.com', 'Deezer'], ['tidal.com', 'Tidal'], ['ustream.tv', 'Ustream'],
    ['shoutcast.com', 'Shoutcast'], ['radionomy.com', 'Radionomy']
  ],
  /* A direct audio URL usually says so in the path — extension first, then a bare port-style
     radio endpoint. This is a hint, never a gate: plenty of working streams carry neither. */
  AUDIO_EXT: /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|m3u8|mpd|webm|mp4|nsv)(?:[?#]|$)/i,
  PAGE_PATH: /\/(?:watch|channel|playlist|album|track|sets|video|episode|p)\b/i,
  mediaErrorText(code){
    /* https://html.spec.whatwg.org/multipage/media.html#error-codes */
    switch(Number(code)){
      case 1: return 'the download was aborted before the stream started';
      case 2: return 'the network dropped, or the host answered with something that is not audio';
      case 3: return 'the data arrived but the browser could not decode it as audio';
      case 4: return 'the server answered, but not with a format this browser can play';
      default: return 'the stream never started';
    }
  },
  init(){
    if(this.wired) return;
    this.wired = true;
    const a = document.createElement('audio');
    a.preload = 'none';
    a.setAttribute('aria-label', 'Mission audio stream');
    a.style.display = 'none';
    document.body.appendChild(a);
    this.el = a;
    /* A URL is only remembered once it has actually made sound — otherwise a typo is persisted
       and silently reinstated on the next page load. */
    a.addEventListener('playing', () => {
      this.setStatus('playing');
      this.clearWatch();
      if(this.cur && this.cur.id === 'custom' && this.cur.page) Store.set(this.URL_KEY, this.cur.page);
    });
    a.addEventListener('waiting', () => this.setStatus('buffering'));
    a.addEventListener('stalled', () => this.setStatus('buffering'));
    a.addEventListener('error', () => {
      if(this.stopping || !this.cur) return;
      const code = (this.el && this.el.error) ? this.el.error.code : 0;
      this.advance(this.mediaErrorText(code), code);
    });
    $('commsVol').value = String(this.vol);
    $('commsPct').textContent = this.vol + '%';
    a.volume = Math.pow(this.vol / 100, 1.5);
    $('commsVol').addEventListener('input', () => {
      this.vol = Number($('commsVol').value) || 0;
      $('commsPct').textContent = this.vol + '%';
      if(this.el) this.el.volume = Math.pow(this.vol / 100, 1.5);
      Store.set(this.VOL_KEY, String(this.vol));
    });
    $('commsToggle').addEventListener('click', e => { e.stopPropagation(); this.panel(); });
    $('commsStop').addEventListener('click', () => this.stop());
    $('commsCustomGo').addEventListener('click', () => this.custom());
    $('commsCustom').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); this.custom(); } });
    const saved = Store.get(this.URL_KEY, '');
    if(saved) $('commsCustom').value = saved;
    document.addEventListener('click', e => {
      const p = $('commsPanel');
      if(!p.classList.contains('open')) return;
      if(e.target.closest && e.target.closest('#commsPanel')) return;
      if(e.target.closest && e.target.closest('#commsToggle')) return;
      p.classList.remove('open');
      $('commsToggle').setAttribute('aria-pressed', 'false');
    });
    this.list();
  },
  panel(){
    this.init();
    const p = $('commsPanel');
    const open = !p.classList.contains('open');
    $('audioPanel').classList.remove('open');       // one popover at a time
    p.classList.toggle('open', open);
    $('commsToggle').setAttribute('aria-pressed', open ? 'true' : 'false');
  },
  list(){
    const host = $('commsList');
    if(!host) return;
    host.innerHTML = this.STREAMS.map(s =>
      `<button class="cm-item" data-cm="${s.id}" aria-pressed="false"><span>▶</span><span>${esc(s.name)}</span><span class="st" data-cmst="${s.id}">${esc(s.sub.split('·')[0].trim())}</span></button>`).join('');
    host.querySelectorAll('[data-cm]').forEach(b => b.addEventListener('click', () => this.play(b.dataset.cm)));
  },
  setStatus(state, msg){
    const eq = $('commsEq');
    if(eq) eq.classList.toggle('on', state === 'playing');
    $('commsNowTitle').textContent = this.cur ? this.cur.name : 'not playing';
    $('commsNowSub').textContent = msg || (this.cur ? (state === 'playing' ? 'live' : state) : 'pick a feed below');
    const err = $('commsErr');
    if(err){ err.hidden = !(state === 'error'); if(msg && state === 'error') err.innerHTML = msg; }
    document.querySelectorAll('[data-cm]').forEach(b => b.classList.toggle('on', !!(this.cur && b.dataset.cm === this.cur.id && state === 'playing')));
    this.paintCustom();
  },
  paintCustom(){},
  play(id){
    this.init();
    const s = this.STREAMS.filter(x => x.id === id)[0];
    if(!s) return;
    if(this.cur && this.cur.id === id && !this.el.paused){ this.stop(); return; }
    this.cur = s; this.urlIndex = 0;
    this.attempt();
  },
  attempt(){
    const s = this.cur;
    if(!s) return;
    const url = s.urls[this.urlIndex];
    if(!url){ this.advance('no more mirrors'); return; }
    this.setStatus('loading', 'connecting · ' + (this.urlIndex + 1) + ' of ' + s.urls.length);
    try{ this.el.src = url; }catch(e){ this.advance('the stream URL could not be set'); return; }
    const p = this.el.play();
    if(p && p.catch) p.catch(() => {
      /* autoplay policies and dead mirrors both land here, so the message names both */
      this.advance('the browser refused to start playback (or the mirror is down) — press play again');
    });
    this.clearWatch();
    this.watch = setTimeout(() => { if(this.el && this.el.paused) this.advance('the stream did not start within ' + (this.TIMEOUT / 1000) + 's'); }, this.TIMEOUT);
  },
  TIMEOUT: 7000,
  clearWatch(){ if(this.watch) clearTimeout(this.watch); this.watch = null; },
  /* one dead mirror costs a mirror, not the station: the listener is walked to the next host,
     and only when every host is exhausted is the feed declared unavailable */
  advance(why, code){
    this.clearWatch();
    const s = this.cur;
    if(!s || this.stopping) return;   // a deliberate stop is not a failure to report
    /* A pasted feed has one URL and no mirrors, so walking the mirror list is meaningless —
       it needs to hear *why* it failed instead of "every mirror was tried". */
    if(s.id === 'custom'){ this.customFail(why, code); return; }
    if(this.urlIndex + 1 < s.urls.length){
      this.urlIndex++;
      this.attempt();
      return;
    }
    this.setStatus('error', 'This feed is not available right now (' + esc(why) + '). Every mirror was tried. '
      + 'You can still listen at <a href="' + s.page + '" target="_blank" rel="noopener noreferrer">' + esc(s.page.replace('https://', '')) + ' ↗</a>, or paste another stream URL below.');
    const st = document.querySelector('[data-cmst="' + s.id + '"]');
    if(st) st.textContent = 'unavailable';
  },
  /* Shows a message in the panel's error slot and parks the transport, without ever claiming
     a feed is playing when it is not. */
  setCustomErr(html, nowTitle){
    const err = $('commsErr');
    if(err){ err.hidden = false; err.innerHTML = html; }
    const eq = $('commsEq'); if(eq) eq.classList.remove('on');
    $('commsNowTitle').textContent = nowTitle || 'Your own feed';
    $('commsNowSub').textContent = 'not playing';
    document.querySelectorAll('[data-cm]').forEach(b => b.classList.remove('on'));
  },
  customFail(why, code){
    /* The reasons an <audio> element cannot play a URL are narrow and worth naming, because
       "it did not work" tells the person pasting nothing they can act on. */
    const host = (() => { try{ return new URL(this.cur.page).hostname.replace(/^www\./, ''); }catch(e){ return 'that host'; } })();
    const decodeNote = Number(code) === 3
      ? '<b>The server did answer, and the bytes arrived.</b> What came back was not decodable audio — usually a login '
        + 'page or an error document with an audio content type, so the URL is close but not the stream itself.'
      : null;
    const hints = [
      '<b>' + esc(host) + ' did not return playable audio.</b> ' + esc(why) + '.',
      'The usual causes, in order of frequency:',
      '<b>1 · It is a web page, not a stream.</b> A share link for Spotify, SoundCloud or Twitch returns HTML. '
        + 'A browser will not let an audio element reach inside a page to pull the sound out — that is the security '
        + 'boundary, and no URL trick gets around it.',
      '<b>2 · The host blocks other sites.</b> Some stations refuse requests whose referer is not their own '
        + 'player. That refusal looks exactly like a dead link from here.',
      '<b>3 · Mixed content.</b> An <span class="mono">http://</span> stream cannot load on an '
        + '<span class="mono">https://</span> page; the browser blocks it before the request leaves.',
      '<b>4 · It needs a session.</b> A private or account-gated stream URL expires, and an expired one '
        + 'returns an error page.',
      'What does work: a URL that <b>is</b> the audio — ending in <span class="mono">.mp3</span>, '
        + '<span class="mono">.m4a</span>, <span class="mono">.ogg</span> or <span class="mono">.m3u8</span>, '
        + 'or a radio server endpoint such as <span class="mono">https://ice1.somafm.com/missioncontrol-128-mp3</span>. '
        + 'Those resolve to a continuous audio response, which is all this player needs.'
    ];
    if(decodeNote) hints.splice(1, 0, decodeNote);
    this.setCustomErr(hints.join('<br><br>'));
  },
  custom(){
    this.init();
    const input = $('commsCustom');
    const v = (input && input.value || '').trim();
    if(!v){ this.setCustomErr('The custom field is empty — paste a direct audio stream URL first.'); return; }
    if(!/^https?:\/\//i.test(v)){
      this.setCustomErr('A stream URL has to start with <b>https://</b> (or <span class="mono">http://</span> on a local page).'
        + (v.includes('://') ? ' That link uses a scheme this player cannot open.' : ' What was pasted is not a URL at all.'));
      return;
    }
    let host = '';
    try{ host = new URL(v).hostname.replace(/^www\./, '').toLowerCase(); }
    catch(e){ this.setCustomErr('That link could not be read as a URL — check for a stray space or a missing part.'); return; }
    /* named page-host rejection, before the player is even touched */
    const page = this.PAGE_HOSTS.filter(h => host === h[0] || host.endsWith('.' + h[0]))[0];
    if(page){
      this.setCustomErr('<b>' + esc(page[1]) + ' does not hand out its audio as a URL.</b> A link like that returns a web page, '
        + 'and an audio element cannot read sound out of a page — so this will always fail, whatever the URL looks like.<br><br>'
        + 'Paste the URL of the audio itself instead: it usually ends in <span class="mono">.mp3</span>, '
        + '<span class="mono">.m4a</span>, <span class="mono">.ogg</span>, <span class="mono">.opus</span> or '
        + '<span class="mono">.m3u8</span>, or it is a bare radio endpoint such as '
        + '<span class="mono">https://ice1.somafm.com/missioncontrol-128-mp3</span>. Radio broadcasters publish these directly; '
        + 'video and music platforms deliberately do not.');
      return;
    }
    if(location.protocol === 'https:' && v.toLowerCase().startsWith('http://')){
      this.setCustomErr('<b>This page is served over https, so an http:// stream is blocked as mixed content.</b> '
        + 'The request never leaves the browser and the failure looks like a dead link. Use the https endpoint of the same '
        + 'stream — most stations publish one alongside the plain one.');
      return;
    }
    if(this.PAGE_PATH.test(v) && !this.AUDIO_EXT.test(v)){
      this.setCustomErr('That path looks like a <b>page</b> rather than a stream, so it will almost certainly fail. '
        + 'Trying it anyway — if it does not start, re-check that the URL points at the audio itself.');
    }
    /* not persisted here: only a URL that actually plays is remembered (see the playing listener) */
    this.cur = { id: 'custom', name: 'Your own feed', sub: 'pasted URL', page: v, urls: [v] };
    this.urlIndex = 0;
    this.attempt();
  },
  stop(){
    this.clearWatch();
    /* blanking the source is what actually stops the download — a paused element keeps its
       buffer, and a hidden-but-live stream is the same defect this teardown avoids */
    this.stopping = true;
    this.cur = null;
    if(this.el){ try{ this.el.pause(); this.el.removeAttribute('src'); this.el.load(); }catch(e){} }
    this.setStatus('idle', 'stopped');
    setTimeout(() => { this.stopping = false; }, 500);
  }
};

export { Chime, Ambient, Comms };
