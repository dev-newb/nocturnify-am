// viz.js — now-playing visualiser (15 modes plus a hidden Auto; ▲ ▼ to cycle).
//
// Audio-reactive from the real signal. Web Audio can't hear MusicKit (Widevine-protected media
// reaches page script as silence), so the native shell taps the TV's output mix with Android's
// Visualizer and streams spectrum bands + waveform in (AudioTap.kt). Beat, loudness and band
// energies are derived here, from that stream — never from a guessed tempo, which drifts
// audibly against the music.
//
// When there's no signal (paused, permission declined, tap unavailable) every audio feature
// eases to a neutral 0.5 and each mode is exactly its ambient self: motion from playback
// position, a per-track seed, and a palette quantised from the cover art's actual pixels.
(function () {
  const W = 1280, H = 720;
  const NPART = 210;
  const FPS = 60;             // load reduction didn't correlate with the audio gaps — restored
  const MODES = ['Drift', 'Orbit', 'Aurora', 'Nebula', 'Starfield', 'Ribbons', 'Lattice', 'Bloom', 'Rain',
                 'Kaleido', 'Murmur', 'Golden', 'Harmonograph', 'Halo', 'Scope'];
  const KAL = 9, MUR = 10, GOL = 11, HAR = 12, HALO = 13, SCOPE = 14;
  const AUDIO_ONLY = new Set([HALO, SCOPE]);   // nothing to show without a signal; Auto skips them then
  const AUTO = MODES.length;            // hidden slot: sits between the last and first
  // per-mode trail persistence. Harmonograph is 1: its persistence lives in its own paper
  // canvas, and a trail on top would multiply the ink's brightness by 1/trail.
  const TRAIL = [0.135, 0.135, 0.09, 0.055, 0.13, 0.10, 0.22, 0.10, 0.20, 0.30, 0.26, 0.16, 1.0, 0.30, 0.22];
  const HOLD = 22, FADE = 5;            // Auto: seconds held, seconds cross-fading
  const ART_CY = H * 0.355, ART_SZ = 268;

  let cv, ctx, raf = 0, opts = null, running = false;
  let poolA = [], poolB = [], sprites = [], curtains = [], rings = [], sharps = [], lits = [], glow = null, pal = null, prevPal = null, palMix = 1;
  let autoIdx = 0, autoT = 0, autoNextReady = -1;
  // accents from a near-black cover are almost invisible as thin strokes; lift them a little
  const lift = (c, m = 0.38) => [c[0] + (255 - c[0]) * m, c[1] + (255 - c[1]) * m, c[2] + (255 - c[2]) * m];
  let lastDraw = 0, flashT = 0, flashTxt = '', hintT = 0;
  let artImg = null, artUrl = '', lastTrack = '';
  let seed = 1, tPrev = 0, tNow = 0, mode = AUTO, modeUntil = 0, seekPreview = null, seekShown = null;

  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const lerp = (a, b, m) => a + (b - a) * m;
  const rgb = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const mmss = ms => { const t = Math.max(0, Math.floor((ms || 0) / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

  // ---- audio ---------------------------------------------------------------------------------
  // The tap sends ~60 lines a second: "a <rms mB> <24 band dB values> | <64 waveform samples>".
  // Modes read only the features in A, all 0..1 and centred on 0.5 when there's no signal:
  //   bands[24]          per-band level, auto-gained against each band's own floor and peak
  //   bass, mid, treble  band-group levels      energy  loudness, slow (~1s) and auto-gained
  //   beat               jumps to 1 on an onset, decays over ~0.2s (0 without a signal)
  //   wave[64]           the waveform, -1..1 (flat without a signal)
  // A.mix is how much of the live signal is in all of that; it eases between 0 and 1, so losing
  // or regaining audio (pause, permission, a quiet intro) never snaps the picture.
  const NB = 24, NW = 64;
  const A = { mix: 0, bands: new Float32Array(NB).fill(0.5), bass: 0.5, mid: 0.5, treble: 0.5, energy: 0.5,
              beat: 0, wave: new Float32Array(NW), state: 'off', peaks: new Float32Array(NB) };
  const R = { seq: 0, used: 0, at: 0, rms: -9600, db: new Float32Array(NB), prev: new Float32Array(NB),
              lo: new Float32Array(NB).fill(12), hi: new Float32Array(NB).fill(30), sm: new Float32Array(NB),
              avg: new Float32Array(NB).fill(20),
              wave: new Float32Array(NW), lv: 0, lvAvg: 0.5, en: 0.5, flux: 0, fluxDev: 1, lastBeat: 0, env: 0, beats: 0 };
  const amp = (v, depth) => 1 + (v - 0.5) * depth;    // 0.5 (no signal) -> exactly 1
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  // Intensity 1–5 (remote 1 / 3): how hard the signal pushes the picture. 3 is what every mode
  // was tuned at; the others scale the swings and the beat around the same calm centre, and
  // shift onset sensitivity so 5 also lands more beats. Features still stay 0..1.
  const GAIN = [0, 0.35, 0.65, 1, 1.4, 1.85], ONSET = [0, 1.3, 1.12, 1, 0.88, 0.76];
  let level = 3, levelAt = -1e9;
  try { level = Math.min(5, Math.max(1, parseInt(localStorage.viz_intensity, 10) || 3)); } catch (e) {}

  function onAudio(line) {
    if (typeof line !== 'string') return;
    if (line[0] !== 'a') {                             // control replies: on / denied / unavailable …
      A.state = line.split(' ')[0];
      console.log('[viz] audio:', line);
      return;
    }
    const bar = line.indexOf('|');
    const head = line.slice(2, bar).split(' '), tail = line.slice(bar + 2).split(' ');
    R.rms = +head[0];
    for (let b = 0; b < NB; b++) R.db[b] = +head[b + 1] || 0;
    for (let i = 0; i < NW; i++) R.wave[i] = (+tail[i] || 0) / 128;
    R.seq++; R.at = performance.now();
  }

  function updateAudio(dt, now) {
    const fresh = R.seq !== R.used;
    R.used = R.seq;
    // live = frames arriving and not silence (-60 dB); paused music sends frames of nothing
    const live = now - R.at < 400 && R.rms > -6000;
    A.mix += ((live ? 1 : 0) - A.mix) * Math.min(1, dt * (live ? 2.2 : 0.9));
    const ease = (tau) => 1 - Math.exp(-dt / tau);
    if (fresh) {
      let flux = 0;
      for (let b = 0; b < NB; b++) {
        const v = R.db[b];
        // Each band is read as its swing around its own recent (~1.2s) average, scaled by its
        // recent range (floor creeps up / peak creeps down, both snapping to new extremes). Where
        // a band sits in absolute terms barely moves in mastered music — measured on the TV, a
        // sustained bass line held a floor-to-peak reading near 0.9 — but its swings are the beat.
        R.lo[b] = v < R.lo[b] ? v : Math.min(R.lo[b] + 3 * dt, R.hi[b] - 8);
        R.hi[b] = v > R.hi[b] ? v : Math.max(R.hi[b] - 6 * dt, R.lo[b] + 8);
        R.avg[b] += (v - R.avg[b]) * ease(1.2);
        const n = clamp01(0.5 + (v - R.avg[b]) / (R.hi[b] - R.lo[b]) * 1.8);
        R.sm[b] += (n - R.sm[b]) * ease(n > R.sm[b] ? 0.035 : 0.16);
        if (b < 10) flux += Math.max(0, v - R.prev[b]) * (b < 5 ? 1.4 : 0.8);   // onsets live low
        R.prev[b] = v;
      }
      // onset: flux well above its own running mean + deviation, at most ~4 a second
      const above = flux - R.flux;
      R.flux += above * 0.06; R.fluxDev += (Math.abs(above) - R.fluxDev) * 0.06;
      if (live && above > (R.fluxDev * 1.8 + 3.5) * ONSET[level] && now - R.lastBeat > 280) { R.env = 1; R.lastBeat = now; R.beats++; }
      // loudness: rms (mB) to 0..1 over -45..-5 dB
      R.lv = clamp01((R.rms / 100 + 45) / 40);
      for (let i = 0; i < NW; i++) A.wave[i] = Math.max(-1, Math.min(1, R.wave[i] * A.mix * GAIN[level]));
    }
    // energy is loudness against the song's own recent average (~8s), not an absolute level:
    // mastered music sits near full scale throughout, so absolute loudness barely moves.
    // +-0.1 of level (4 dB) spans the whole 0..1 range.
    if (live) R.lvAvg += (R.lv - R.lvAvg) * ease(8);
    R.en += (clamp01(0.5 + (R.lv - R.lvAvg) * 5) - R.en) * ease(0.6);
    R.env *= Math.exp(-dt / 0.19);
    const m = A.mix, g = m * GAIN[level];
    let bs = 0, md = 0, tr = 0;
    for (let b = 0; b < NB; b++) {
      A.bands[b] = clamp01(0.5 + (R.sm[b] - 0.5) * g);
      A.peaks[b] = Math.max(A.bands[b], A.peaks[b] - dt * 0.5);
      if (b < 5) bs += R.sm[b]; else if (b < 14) md += R.sm[b]; else tr += R.sm[b];
    }
    A.bass = clamp01(0.5 + (bs / 5 - 0.5) * g);
    A.mid = clamp01(0.5 + (md / 9 - 0.5) * g);
    A.treble = clamp01(0.5 + (tr / 10 - 0.5) * g);
    A.energy = clamp01(0.5 + (R.en - 0.5) * g);
    A.beat = R.env * g;
    A.onset = R.lastBeat !== R.seen && m > 0.3;        // true for the one frame a beat lands
    R.seen = R.lastBeat;
  }
  const bandAvg = (lo, hi) => { let t = 0; for (let b = lo; b < hi; b++) t += A.bands[b]; return t / (hi - lo); };

  try {
    const v = localStorage.viz_mode || '';
    const byName = v === 'Auto' ? AUTO : MODES.indexOf(v);
    const legacy = parseInt(v, 10);          // older builds stored an index, and Auto was 9
    mode = !v ? AUTO : byName >= 0 ? byName : (legacy === 9 ? AUTO : (legacy >= 0 && legacy < 9 ? legacy : 0));
  } catch (e) {}

  // ---- palette straight out of the cover art -------------------------------
  async function palette(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('art')); img.src = url; });
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    const buckets = new Map();
    let lumSum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      lumSum += 0.299 * r + 0.587 * gg + 0.114 * b;
      const key = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4);
      const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
      e.r += r; e.g += gg; e.b += b; e.n++; buckets.set(key, e);
    }
    const cols = [...buckets.values()].map(e => {
      const r = e.r / e.n, g2 = e.g / e.n, b = e.b / e.n;
      const mx = Math.max(r, g2, b), mn = Math.min(r, g2, b);
      const sat = mx ? (mx - mn) / mx : 0;
      const lum = (0.299 * r + 0.587 * g2 + 0.114 * b) / 255;
      return { r, g: g2, b, sat, lum, score: e.n * (0.25 + sat) * (0.30 + lum) };
    }).sort((a, b) => b.score - a.score);
    const vivid = cols.filter(c2 => c2.sat > 0.22 && c2.lum > 0.14).slice(0, 4);
    const acc = (vivid.length ? vivid : cols.slice(0, 3)).map(c2 => [c2.r, c2.g, c2.b]);
    const dark = cols.slice().sort((a, b) => a.lum - b.lum)[0] || { r: 10, g: 10, b: 16 };
    return { bg: [dark.r * 0.30 + 4, dark.g * 0.30 + 4, dark.b * 0.34 + 7], acc, img, lum: lumSum / (d.length / 4) / 255 };
  }

  function buildSprites(p) {
    sprites = p.acc.map(c => {
      const s = document.createElement('canvas'); s.width = s.height = 64;
      const g = s.getContext('2d');
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.85)`);
      grd.addColorStop(0.35, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.22)`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
      return s;
    });
    // one soft vertical strip per accent colour (pre-tinted: 'lighter' can't colourise a white sprite)
    // the art glow was a fresh createRadialGradient + large alpha fillRect every single frame;
    // bake it once per palette and just blit it
    glow = document.createElement('canvas'); glow.width = glow.height = 256;
    {
      const g = glow.getContext('2d');
      const a = p.acc[0] || [120, 140, 180];
      const rg = g.createRadialGradient(128, 128, 34, 128, 128, 128);
      rg.addColorStop(0, `rgba(${a[0] | 0},${a[1] | 0},${a[2] | 0},0.42)`);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
    }
    // A crisp point: bright opaque core with a fast falloff, for the sharp quarter of stars
    sharps = p.acc.map(c => {
      const s = document.createElement('canvas'); s.width = s.height = 32;
      const g = s.getContext('2d');
      const col = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
      const rg = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      rg.addColorStop(0.00, `rgba(${col},1)`);
      rg.addColorStop(0.34, `rgba(${col},0.92)`);
      rg.addColorStop(0.52, `rgba(${col},0.22)`);
      rg.addColorStop(1.00, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(0, 0, 32, 32);
      return s;
    });
    // The same crisp point, lifted toward white: thin marks (birds, ink) vanish in a dark accent
    lits = p.acc.map(c0 => {
      const c = lift(c0, 0.45);
      const s = document.createElement('canvas'); s.width = s.height = 32;
      const g = s.getContext('2d');
      const col = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
      const rg = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      rg.addColorStop(0.00, `rgba(${col},1)`);
      rg.addColorStop(0.34, `rgba(${col},0.92)`);
      rg.addColorStop(0.52, `rgba(${col},0.22)`);
      rg.addColorStop(1.00, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(0, 0, 32, 32);
      return s;
    });
    // Bloom draws rings, not blobs, so it doesn't read as "Drift in a circle"
    rings = p.acc.map(c => {
      const s = document.createElement('canvas'); s.width = s.height = 64;
      const g = s.getContext('2d');
      const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      const col = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
      rg.addColorStop(0.00, `rgba(${col},0)`);
      rg.addColorStop(0.52, `rgba(${col},0.03)`);
      rg.addColorStop(0.74, `rgba(${col},0.95)`);
      rg.addColorStop(0.86, `rgba(${col},0.22)`);
      rg.addColorStop(1.00, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
      return s;
    });
    curtains = p.acc.map(c => {
      const s = document.createElement('canvas'); s.width = 64; s.height = 256;
      const g = s.getContext('2d');
      const lg = g.createLinearGradient(0, 0, 0, 256);
      lg.addColorStop(0, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0)`);
      lg.addColorStop(0.45, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.92)`);
      lg.addColorStop(1, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0)`);
      g.fillStyle = lg; g.fillRect(0, 0, 64, 256);
      const hg = g.createLinearGradient(0, 0, 64, 0);
      hg.addColorStop(0, 'rgba(0,0,0,1)'); hg.addColorStop(0.5, 'rgba(0,0,0,0)'); hg.addColorStop(1, 'rgba(0,0,0,1)');
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = hg; g.fillRect(0, 0, 64, 256);
      return s;
    });
  }

  const mkPool = n => Array.from({ length: n }, () => ({}));

  // Each mode owns how it seeds and draws a pool. Every alpha is multiplied by `w` so two
  // modes can be drawn at once and cross-faded (Auto) without any offscreen buffers.
  function initFor(id, pool) {
    for (const p of pool) {
      p.x = rnd() * W; p.y = rnd() * H;
      p.sp = 14 + rnd() * 46;
      p.sz = 12 + rnd() * 46;
      p.si = (rnd() * Math.max(1, sprites.length)) | 0;
      p.life = 3 + rnd() * 7;
      p.age = rnd() * p.life;
      p.r = 120 + rnd() * 900;                 // Orbit radius
      p.a = rnd() * Math.PI * 2;
      p.dir = rnd() < 0.5 ? -1 : 1;
      // Nebula: few, huge, slow
      p.nr = 170 + rnd() * 380;
      p.nvx = (rnd() - 0.5) * 17.64; p.nvy = (rnd() - 0.5) * 12.6;  // 14/10 base, +20% then +5%
      p.nph = rnd() * Math.PI * 2;
      // Starfield: normalised direction + depth
      p.dx = (rnd() - 0.5) * 2; p.dy = (rnd() - 0.5) * 2;
      p.z = 0.05 + rnd() * 0.95;
      p.sx = null; p.sy = null; p.comet = false; p.tail = null;
      // Rain: column, fall speed, streak length
      p.rx = -W * 0.25 + rnd() * W * 1.5; p.ry = rnd() * H; p.rs = 240 + rnd() * 520;
      p.rl = 12 + rnd() * 70; p.rw = 1.6 + rnd() * 4.4; p.rd = (rnd() - 0.5) * 18;
      // Bloom: orbiting seed point mirrored around the centre
      p.br = 47 + rnd() * 354; p.ba = rnd() * Math.PI * 2; p.bs = (0.15 + rnd() * 0.5) * (rnd() < 0.5 ? -1 : 1);
      p.escV = 34 + rnd() * 46;   // escape speed: kind of slow, to a bit faster
      p.br0 = p.br; p.esc = 0;
      p.escK = 0.25 + rnd() * rnd() * 15.75;   // escape swell: mostly slight, occasionally huge
      p.stroked = rnd() < 0.25;                // a quarter of stars draw as stroked segments
      // Murmur: a fixed spot on the flock's sheet (roughly gaussian), sub-flock, lag, brightness
      p.mu = (rnd() + rnd() + rnd() - 1.5) * 2 * 150;
      p.mw = (rnd() + rnd() + rnd() - 1.5) * 2 * 48;
      p.mg = rnd() < 0.38; p.mr = 0.05 + rnd() * 0.2; p.mb = 0.6 + rnd() * 0.8; p.ms = rnd() * 2.2;
      p.mx = null; p.my = null;
      p.bi = (rnd() * NB) | 0;                 // the spectrum band this particle listens to
    }
    if (id === KAL) { kalN = [8, 10, 12][(rnd() * 3) | 0]; kalPh = rnd() * 6.283; kalDir = rnd() < 0.5 ? -1 : 1; }
    if (id === MUR) { murPh = rnd() * 6.283; murDir = rnd() < 0.5 ? -1 : 1; }
    if (id === GOL) { golPh = rnd() * 6.283; golDir = rnd() < 0.5 ? -1 : 1; golFam = [13, 21, 34][(rnd() * 3) | 0]; }
    if (id === HAR) { if (px) px.clearRect(0, 0, W, H); newSwing(); }
  }

  function field(x, y, t, k) {
    const s = 0.0024 * k;
    return Math.sin(x * s + t * 0.26) * 1.8
         + Math.cos(y * s * 1.27 - t * 0.20) * 1.8
         + Math.sin((x + y) * s * 0.55 + t * 0.12) * 1.25;
  }

  function mDrift(pool, w, dt, mv, k) {
    ctx.globalCompositeOperation = 'lighter';
    for (const p of pool) {
      const ang = field(p.x, p.y, tNow, k);
      const surge = 1 + A.beat * 3;                    // every beat throws the motes along the flow
      p.x += Math.cos(ang) * p.sp * dt * mv * surge;
      p.y += Math.sin(ang) * p.sp * dt * mv * surge;
      p.age += dt * mv;
      if (p.age > p.life || p.x < -60 || p.x > W + 60 || p.y < -60 || p.y > H + 60) {
        p.x = rnd() * W; p.y = rnd() * H; p.age = 0;
      }
      const f = Math.sin(Math.min(1, p.age / p.life) * Math.PI);
      const sp = sprites[p.si]; if (!sp) continue;
      const bv = A.bands[p.bi], sz = p.sz * (amp(bv, 1.6) + A.beat * 0.8);   // each mote listens to its own band
      ctx.globalAlpha = Math.min(1, 0.30 * f * (amp(bv, 1.7) + A.beat * 0.7)) * w;
      ctx.drawImage(sp, p.x - sz / 2, p.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  function mOrbit(pool, w, dt, mv) {
    ctx.globalCompositeOperation = 'lighter';
    const kick = amp(A.bass, 0.3) + A.beat * 0.12;      // the whole system breathes on the bass
    for (const p of pool) {
      p.a += p.dir * (0.34 / (0.45 + p.r / 300)) * dt * mv * (1 + A.beat * 2.5);
      const x = W / 2 + Math.cos(p.a) * p.r * kick;
      const y = H / 2 + Math.sin(p.a) * p.r * 0.62 * kick;
      p.age += dt * mv;
      if (p.age > p.life) p.age = 0;
      const f = Math.sin(Math.min(1, p.age / p.life) * Math.PI);
      const sp = sprites[p.si]; if (!sp) continue;
      const bv = A.bands[p.bi], sz = p.sz * (amp(bv, 1.5) + A.beat * 0.6);
      ctx.globalAlpha = Math.min(1, 0.30 * f * (amp(bv, 1.7) + A.beat * 0.6)) * w;
      ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  function mAurora(pool, w) {
    if (!curtains.length) return;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) {
      const g = bandAvg(i * 3, i * 3 + 4);             // each curtain is its own slice of the spectrum
      const x = W / 2 + Math.sin(tNow * 0.17 + i * 1.7) * W * 0.36;
      const cw = 130 + Math.sin(tNow * 0.23 + i * 2.1) * 70;
      const hh = H * (0.75 + Math.sin(tNow * 0.13 + i) * 0.18) * amp(g, 0.9);
      const y = H * 0.5 - hh / 2 + Math.sin(tNow * 0.11 + i * 0.9) * 40;
      ctx.globalAlpha = Math.min(1, 0.20 * (amp(g, 1.8) + A.beat * 0.8)) * w;
      ctx.drawImage(curtains[i % curtains.length], x - cw / 2, y, cw, hh);
    }
    ctx.globalAlpha = 1;
  }

  // Nebula — a few enormous soft clouds, slowly breathing and drifting past each other.
  function mNebula(pool, w, dt, mv) {
    ctx.globalCompositeOperation = 'lighter';
    const n = Math.min(pool.length, 30);
    for (let i = 0; i < n; i++) {
      const p = pool[i];
      p.x += p.nvx * dt * mv; p.y += p.nvy * dt * mv;
      p.nph += dt * mv * 0.25;
      if (p.x < -p.nr) p.x = W + p.nr; else if (p.x > W + p.nr) p.x = -p.nr;
      if (p.y < -p.nr) p.y = H + p.nr; else if (p.y > H + p.nr) p.y = -p.nr;
      const r = p.nr * (0.86 + Math.sin(p.nph) * 0.14) * (amp(A.bass, 0.5) + A.beat * 0.14);
      const sp = sprites[p.si]; if (!sp) continue;
      ctx.globalAlpha = (0.085 * amp(A.energy, 0.8) + A.beat * 0.07) * w;
      ctx.drawImage(sp, p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  // Starfield — benchmarking showed stroke() costs ~2-3ms a call on this panel even when
  // batched (74% janky frames), while drawImage of 210 sprites costs ~8ms total. So the stars
  // are drawn as depth-scaled dots and the streaks come from the trail persistence instead —
  // the smear IS the motion blur. One star is occasionally promoted to a comet: same radial
  // path, just larger and brighter with a tail of fading sprites.
  const SB_A = [0.40, 0.66, 0.92], SB_W = [1.1, 2.0, 3.4];   // stroked stars, per depth band
  function mStars(pool, w, dt, mv) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const ns = Math.max(1, sprites.length);
    let cometCount = 0, comet = null;
    for (const p of pool) if (p.comet) cometCount++;

    const warp = amp(A.energy, 0.9) + A.beat * 3.2;     // a surge forward on every beat
    const twinkle = amp(A.treble, 0.9) + A.beat * 0.4;
    for (const p of pool) {
      p.z -= dt * mv * 0.34 * warp;
      const x = W / 2 + (p.dx / p.z) * 210;
      const y = H / 2 + (p.dy / p.z) * 210;
      if (p.z < 0.06 || x < -220 || x > W + 220 || y < -220 || y > H + 220) {
        if (p.comet) { p.comet = false; cometCount--; }
        p.dx = (rnd() - 0.5) * 2; p.dy = (rnd() - 0.5) * 2; p.z = 1; p.tail = null;
        // cx/cy must go too: the final pass copies them into sx/sy, and a stale value would
        // be stroked next frame as a line from the old position to the new spawn point.
        p.sx = null; p.sy = null; p.cx = null; p.cy = null; p.vis = false;
        if (cometCount === 0 && rnd() < 0.04) {
          p.comet = true; p.tail = []; p.cometStroke = rnd() < 0.5; cometCount++;
        }
        continue;
      }
      const near = 1 - p.z;
      p.cx = x; p.cy = y;
      p.band = p.z > 0.66 ? 0 : (p.z > 0.33 ? 1 : 2);
      p.vis = p.sx != null;
      if (p.comet) { comet = p; continue; }
      if (p.stroked) continue;                       // drawn in the batched pass below
      const sp = sprites[p.si % ns]; if (!sp) continue;
      const r = 2.5 + near * 15;
      ctx.globalAlpha = Math.min(1, (0.22 + near * 0.58) * twinkle) * w;
      ctx.drawImage(sp, x - r, y - r, r * 2, r * 2);
    }

    // The stroked quarter, batched to three calls (one per depth band). Stroke costs ~2-3ms a
    // CALL on this panel regardless of how many segments it carries, so the count of calls is
    // what matters, not the count of stars.
    const sc = lift(pal.acc[0] || [210, 220, 245], 0.45);
    const scStr = `${sc[0] | 0},${sc[1] | 0},${sc[2] | 0}`;
    for (let band = 0; band < 3; band++) {
      let any = false;
      ctx.beginPath();
      for (const p of pool) {
        if (!p.stroked || !p.vis || p.comet || p.band !== band) continue;
        ctx.moveTo(p.sx, p.sy); ctx.lineTo(p.cx, p.cy); any = true;
      }
      if (!any) continue;
      ctx.strokeStyle = `rgba(${scStr},${Math.min(1, SB_A[band] * twinkle * w).toFixed(3)})`;
      ctx.lineWidth = SB_W[band];
      ctx.stroke();
    }

    if (comet) {
      const p = comet, near = 1 - p.z;
      p.tail.unshift({ x: p.cx, y: p.cy });
      if (p.tail.length > 16) p.tail.pop();
      const n = p.tail.length;
      const c = lift(pal.acc[p.si % Math.max(1, pal.acc.length)] || [225, 238, 255], 0.6);
      if (p.cometStroke && n > 1) {
        const rgbStr = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
        const L = [[n, 2, 0.24], [Math.max(2, (n * 0.55) | 0), 4.5, 0.38], [Math.max(2, (n * 0.25) | 0), 7.5, 0.58]];
        for (let li = 0; li < 3; li++) {
          ctx.strokeStyle = `rgba(${rgbStr},${(L[li][2] * near * w).toFixed(3)})`;
          ctx.lineWidth = L[li][1];
          ctx.beginPath();
          ctx.moveTo(p.tail[0].x, p.tail[0].y);
          for (let j = 1; j < L[li][0]; j++) ctx.lineTo(p.tail[j].x, p.tail[j].y);
          ctx.stroke();
        }
      } else {
        const sp = sprites[p.si % ns];
        if (sp) for (let j = n - 1; j >= 0; j--) {
          const f = 1 - j / n;
          const r = (5 + near * 26) * f;
          ctx.globalAlpha = 0.65 * f * near * w;
          ctx.drawImage(sp, p.tail[j].x - r, p.tail[j].y - r, r * 2, r * 2);
        }
      }
    }

    for (const p of pool) { p.sx = p.cx; p.sy = p.cy; }
    ctx.globalAlpha = 1;
  }

  // Ribbons — long silk bands woven from summed sines.
  function mRibbons(pool, w) {
    ctx.globalCompositeOperation = 'lighter';
    const bands = 4, step = 30;
    const groups = [A.bass, bandAvg(5, 10), bandAvg(10, 16), A.treble];   // one ribbon per register
    for (let b = 0; b < bands; b++) {
      const c = pal.acc[b % pal.acc.length] || [180, 200, 235];
      const g = groups[b];
      const ph = b * 1.24, am = H * (0.10 + (b % 3) * 0.045) * (amp(g, 1.6) + A.beat * 0.25);
      ctx.strokeStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.min(1, 0.20 * (amp(g, 1.4) + A.beat * 0.6) * w).toFixed(3)})`;
      ctx.lineWidth = (10 + (b % 3) * 7) * amp(g, 0.9);
      ctx.beginPath();
      for (let x = -step; x <= W + step; x += step) {
        const y = H / 2
          + Math.sin(x * 0.0043 + tNow * 0.42 + ph) * am
          + Math.sin(x * 0.0017 - tNow * 0.25 + ph * 1.7) * am * 0.7
          + Math.sin(tNow * 0.15 + ph) * 40;
        if (x <= -step) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Lattice — a standing wave crossing a geometric grid; only crests are drawn, so most
  // cells cost nothing and the field reads as a pulse travelling outward.
  // With a signal, distance from the centre is pitch — bass in the middle, treble at the rim — and
  // every beat launches a ring outward through the grid.
  let latRing = -1, latRingS = 0;
  function mLattice(pool, w, dt, mv) {
    ctx.globalCompositeOperation = 'lighter';
    const cols = 22, rows = 13, dx = W / cols, dy = H / rows;
    const ns = Math.max(1, sprites.length);
    if (A.onset) { latRing = 0; latRingS = A.mix; }
    if (latRing >= 0) { latRing += 760 * dt; if (latRing > 800) latRing = -1; }
    for (let gy = 0; gy < rows; gy++) {
      const y = (gy + 0.5) * dy, ry = y - H / 2;
      for (let gx = 0; gx < cols; gx++) {
        const x = (gx + 0.5) * dx, rx = x - W / 2;
        const d = Math.sqrt(rx * rx + ry * ry);
        let f = Math.sin(d * 0.011 - tNow * 1.5);
        if (latRing >= 0) { const q = (d - latRing) / 55; f += latRingS * 0.9 * Math.exp(-q * q); }
        if (f < 0.05) continue;                       // troughs cost nothing
        if (f > 1) f = 1;
        const sp = sprites[(gx + gy) % ns]; if (!sp) continue;
        const bv = A.bands[Math.min(NB - 1, (d / 740 * NB) | 0)];
        const r = (6 + f * 30) * amp(bv, 1.5);
        ctx.globalAlpha = Math.min(1, 0.50 * f * amp(bv, 1.6)) * w;
        ctx.drawImage(sp, x - r, y - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Bloom — rotational symmetry: a handful of orbiting points mirrored into eight arms.
  // Drawn as glowing rings of varying scale so the mandala reads as its own thing rather
  // than the same soft dots Drift and Orbit use.
  function mBloom(pool, w, dt, mv) {
    if (!rings.length) return;
    ctx.globalCompositeOperation = 'lighter';
    const ARMS = 8, N = Math.min(pool.length, 24), TAU = Math.PI * 2;
    let escaping = 0;
    for (let i = 0; i < N; i++) if (pool[i].esc) escaping++;

    for (let i = 0; i < N; i++) {
      const p = pool[i];
      const sp = rings[p.si % rings.length]; if (!sp) continue;

      if (p.esc === 0) {
        p.ba += p.bs * dt * mv * 0.35;
        if (escaping < 2 && (rnd() < dt * mv * 0.0127 || (A.onset && rnd() < 0.12))) { p.esc = 1; escaping++; }   // ~15% more; beats free some
      }

      if (p.esc === 0) {
        const rr = p.br * (0.85 + Math.sin(tNow * 0.5 + i) * 0.15);
        const sz = (14 + p.sz * 1.15) * (0.75 + Math.sin(tNow * 0.7 + i * 1.9) * 0.25) * (amp(A.bass, 1.1) + A.beat * 0.45);
        ctx.globalAlpha = (0.14 + 0.12 * (1 - i / N)) * w;
        // Instability rises sharply toward the centre. Jitter is per-ARM, not per-point, so
        // the inner rings fray out of symmetry instead of wobbling in lockstep.
        const centre = Math.max(0, 1 - (p.br0 - 47) / 354);
        const jAmp = centre * centre * 16;
        for (let kk = 0; kk < ARMS; kk++) {
          const a2 = p.ba + (kk / ARMS) * TAU;
          let x = W / 2 + Math.cos(a2) * rr;
          let y = H / 2 + Math.sin(a2) * rr * 0.72;
          if (jAmp > 0.15) {
            const ph = i * 2.3 + kk * 1.7;
            x += Math.sin(tNow * 5.5 + ph) * jAmp + Math.sin(tNow * 11.3 + ph * 1.9) * jAmp * 0.5;
            y += Math.cos(tNow * 6.1 + ph) * jAmp + Math.cos(tNow * 12.7 + ph * 2.3) * jAmp * 0.5;
          }
          ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz);
        }
        continue;
      }

      // Escaping: a SINGLE ring, no longer mirrored into the arms — breaking the symmetry is
      // what makes it read as one ring leaving rather than an eight-fold burst. It simply
      // keeps drifting outward and off the screen; no hugging or sliding along the edge.
      const m = 46;
      const ca = Math.abs(Math.cos(p.ba)), sa = Math.abs(Math.sin(p.ba));
      const edgeR = Math.min(ca > 1e-3 ? (W / 2 + m) / ca : 1e6,
                             sa > 1e-3 ? (H / 2 + m) / (0.72 * sa) : 1e6);
      p.br += p.escV * dt * mv;
      p.ba += p.bs * dt * mv * 0.18;
      // On reaching the screen edge it starts fading out over a random 5-10s. It keeps
      // drifting meanwhile, but by then the ring is large enough that a good part of it is
      // still on screen, so the fade actually reads.
      if (p.esc === 1 && p.br >= edgeR) { p.esc = 2; p.escFadeT = 0; p.escFadeDur = 3 + rnd() * 3; }
      let escAlpha = 1;
      if (p.esc === 2) {
        p.escFadeT += dt * mv;
        escAlpha = Math.max(0, 1 - p.escFadeT / p.escFadeDur);
        if (p.escFadeT >= p.escFadeDur) { p.esc = 0; p.br = p.br0; escaping--; continue; }
      }
      // swell as it nears the edge; escK spreads this from barely-any to very large
      const grow = 1 + Math.max(0, p.br - p.br0) / 250 * p.escK;
      const sz = Math.min(760, (14 + p.sz * 1.15) * grow);   // clamp: huge sprites are pure fill cost
      const x = W / 2 + Math.cos(p.ba) * p.br;
      const y = H / 2 + Math.sin(p.ba) * p.br * 0.72;
      ctx.globalAlpha = 0.26 * escAlpha * w;
      ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  // Rain — directional fall. Wind is global, so instead of transforming 210 sprites the
  // canvas is rotated ONCE per frame and every streak is drawn vertically inside it; they
  // tilt together the way real wind-blown rain does, for one matrix op. The field is spawned
  // wider than the screen so the rotated corners stay covered.
  function mRain(pool, w, dt, mv) {
    if (!curtains.length) return;
    // two slow out-of-phase sines: a gentle, non-repeating gust rather than a metronome
    const gust = Math.sin(tNow * 0.085) * 0.62 + Math.sin(tNow * 0.031 + 1.3) * 0.38;
    const tilt = gust * 0.17;                       // radians, ~10 degrees at full gust
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.translate(W / 2, 0); ctx.rotate(tilt); ctx.translate(-W / 2, 0);
    const nc = curtains.length;
    for (const p of pool) {
      p.ry += p.rs * dt * mv * (amp(A.energy, 0.8) + A.beat * 1.5);
      p.rx += (gust * 26 + p.rd) * dt * mv;         // drift with the gust, plus its own bias
      if (p.ry - p.rl > H + 40) { p.ry = -p.rl - rnd() * 260; p.rx = -W * 0.25 + rnd() * W * 1.5; }
      if (p.rx < -W * 0.3) p.rx += W * 1.6; else if (p.rx > W * 1.3) p.rx -= W * 1.6;
      const near = p.rs > 600 ? 1 : (p.rs > 420 ? 0.68 : 0.42);
      const cw = p.rw * (0.55 + near * 0.85);       // per-streak width, scaled by depth
      ctx.globalAlpha = Math.min(1, (0.14 + near * 0.34) * (amp(A.treble, 0.9) + A.beat * 0.5)) * w;
      ctx.drawImage(curtains[p.si % nc], p.rx - cw / 2, p.ry - p.rl, cw, p.rl);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ---- Kaleido -------------------------------------------------------------------------------
  // The cover art itself, cut into a wedge and mirrored into a mandala that radiates from behind
  // the art. One clip and one drawImage build the wedge off-screen each frame; the n-fold figure
  // is then n blits of it with a rotation, every other one mirrored so the seams line up.
  let kal = null, kx = null, kalN = 10, kalPh = 0, kalDir = 1;
  const KAL_R = 820;                                  // reaches the far corner from the art centre
  function mKaleido(pool, w) {
    if (!artImg) return;
    if (!kal) { kal = document.createElement('canvas'); kal.width = KAL_R; kal.height = 640; kx = kal.getContext('2d'); }
    const half = Math.PI / kalN, kc = kal.height / 2;
    const kh = Math.min(kal.height, Math.ceil(2 * KAL_R * Math.sin(half)) + 4);
    kx.setTransform(1, 0, 0, 1, 0, 0);
    kx.clearRect(0, 0, KAL_R, kal.height);
    kx.save();
    kx.beginPath(); kx.moveTo(0, kc); kx.arc(0, kc, KAL_R, -half, half); kx.closePath(); kx.clip();
    // a magnified copy of the art turns (and drifts slightly) under the wedge, so the figure keeps
    // re-forming — like turning the tube of a real kaleidoscope
    const S = 1150 * (amp(A.bass, 0.16) + A.beat * 0.07);
    kx.translate(KAL_R / 2 + Math.sin(tNow * 0.071 + kalPh) * 40,
                 kc + Math.sin(tNow * 0.053 + kalPh * 1.7) * 40);
    kx.rotate(tNow * 0.045 + kalPh);
    kx.drawImage(artImg, -S / 2, -S / 2, S, S);
    kx.restore();

    const cx = W / 2, cy = ART_CY, spin = tNow * 0.028 * kalDir;
    ctx.globalCompositeOperation = 'source-over';
    const lum = prevPal && palMix < 1 ? lerp(prevPal.lum ?? 0.35, pal.lum ?? 0.35, palMix) : (pal.lum ?? 0.35);
    ctx.globalAlpha = Math.min(1, 0.19 * Math.max(0.6, Math.min(1.6, 0.35 / Math.max(0.05, lum))) * (1 + A.beat * 0.6)) * w;
    for (let i = 0; i < kalN; i++) {
      const a = spin + i * 2 * half, m = (i & 1) ? -1 : 1;
      const c = Math.cos(a), sn = Math.sin(a);
      ctx.setTransform(c, sn, -m * sn, m * c, cx, cy);
      ctx.drawImage(kal, 0, kc - kh / 2, KAL_R, kh, 0, -kh / 2, KAL_R, kh);   // the wedge's strip only
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    scrimText(w);
    ctx.globalAlpha = 1;
  }

  // ---- Murmur --------------------------------------------------------------------------------
  // A starling murmuration without flocking maths (O(n^2) is too much for this CPU). Each bird is
  // a fixed spot on a sheet that is tumbled in 3-D and projected: face-on the flock is a thin
  // veil, edge-on it collapses into a dense bright blade — that density swing IS the look.
  // Waves travel along the sheet, and every bird chases its target with its own lag, so ripples
  // pass THROUGH the flock instead of the whole thing moving rigidly.
  let murPh = 0, murDir = 1;
  function mMurmur(pool, w, dt) {
    const ns = Math.max(1, lits.length), t = tNow;
    const orbit = t * 0.05 * murDir + murPh;            // a slow circuit around the cover
    const cx = W / 2 + Math.cos(orbit) * W * 0.31 + Math.sin(t * 0.143) * W * 0.04;
    const cy = ART_CY + 50 + Math.sin(orbit) * H * 0.31 + Math.sin(t * 0.097) * H * 0.04;
    const split = Math.pow(Math.max(0, Math.sin(t * 0.047 + murPh)), 3) * 190;   // now and then, two flocks
    const rot = orbit + murDir * Math.PI / 2 + Math.sin(t * 0.11) * 0.5;       // stream along the path
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const ct = Math.cos(t * 0.21 + murPh);              // the sheet's tumble about its long axis
    const stretch = 1 + Math.sin(t * 0.13) * 0.35;
    const dense = 1 / (0.22 + Math.abs(ct));            // edge-on: birds stack up, so brighter
    const k = Math.min(3, dt * 60);
    const waveU = 26 * (amp(A.mid, 1.8) + A.beat * 1.2), waveV = 38 * amp(A.bass, 1.6), shine = amp(A.energy, 0.7) + A.beat * 0.6;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      let u = p.mu * stretch, v = p.mw;
      u += Math.sin(u * 0.012 - t * 1.7) * waveU;      // compression wave running along the flock
      v += Math.sin(u * 0.009 + t * 0.9) * waveV;       // slow S-bend
      const vy = v * ct, uu = u + (p.mg ? split : -split * 0.55);
      const tx = cx + uu * cr - vy * sr, ty = cy + uu * sr + vy * cr;
      if (p.mx == null) { p.mx = tx; p.my = ty; }
      const f = 1 - Math.pow(1 - p.mr, k);
      p.mx += (tx - p.mx) * f; p.my += (ty - p.my) * f;
      const sp = lits[i % ns]; if (!sp) continue;
      const r = 2.2 + p.ms * 1.1;
      ctx.globalAlpha = Math.min(1, 0.5 * dense * p.mb * shine) * w;
      ctx.drawImage(sp, p.mx - r, p.my - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Golden --------------------------------------------------------------------------------
  // Phyllotaxis around the cover: seed i sits at angle i*theta, radius proportional to sqrt(i) —
  // the sunflower's rule, with the art as the flower's heart. theta breathes a fraction of a
  // degree either side of the golden angle; because the error compounds with i, the outer florets
  // re-sort into sweeping spiral arms and then settle back into the perfect sunflower. Light runs
  // along one family of Fibonacci spirals (seeds 13, 21 or 34 apart are neighbours).
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  let golPh = 0, golDir = 1, golFam = 21;
  const golHist = new Float32Array(128).fill(0.5); let golAt = 0;   // recent bass, newest at golAt
  function mGolden(pool, w) {
    golAt = (golAt + 1) & 127; golHist[golAt] = A.bass + A.beat * 0.4;
    const ns = Math.max(1, sharps.length), t = tNow, n = Math.min(pool.length, 200);
    const theta = GOLDEN + Math.sin(t * 0.031 + golPh) * 0.0105 + Math.sin(t * 0.083) * 0.0028;
    const spin = t * 0.035 * golDir;
    const cx = W / 2, cy = ART_CY, c = 42, i0 = 14.5;   // i0 opens a hole the size of the art
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const echo = golHist[(golAt - ((i * 0.45) | 0)) & 127];   // seed i sees the bass of i*0.45 frames ago
      const r = c * Math.sqrt(i + i0) * (1 + Math.sin(t * 0.55 - i * 0.045) * 0.035) * amp(echo, 0.3);   // outward pulse
      const a = i * theta + spin;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (x < -30 || x > W + 30 || y < -30 || y > H + 30) continue;
      const arm = i % golFam;
      const lit0 = 0.5 + 0.5 * Math.sin(arm / golFam * 6.2832 - t * 0.9);
      const lit = Math.min(1, lit0 + (A.bands[(arm * NB / golFam) | 0] - lit0) * A.mix * 0.8 + A.beat * 0.3);
      const sp = sharps[arm % ns]; if (!sp) continue;
      const sz = (9 + Math.sqrt(i) * 1.5) * (0.75 + lit * 0.5);
      ctx.globalAlpha = (0.20 + lit * 0.55) * w;
      ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Harmonograph --------------------------------------------------------------------------
  // A Victorian pendulum drawing machine. One pendulum swings the pen in x, one in y, each with a
  // smaller octave partner that adds curls. The x:y ratio is a musical interval, detuned a hair
  // so the figure slowly precesses. The pen inks its own paper canvas, which fades slowly, so you
  // watch each figure being drawn. When the swing dies the pen lifts, the paper clears, and a new
  // interval begins.
  const INTERVALS = [[2, 3, 'perfect fifth'], [3, 4, 'perfect fourth'], [4, 5, 'major third'],
                     [5, 6, 'minor third'], [3, 5, 'major sixth'], [1, 2, 'octave'], [5, 8, 'minor sixth']];
  let paper = null, px = null, harm = null, harmAmp = 1;
  function newSwing() {
    const iv = INTERVALS[(rnd() * INTERVALS.length) | 0];
    const base = 0.55 + rnd() * 0.25;
    const det = (0.008 + rnd() * 0.012) * (rnd() < 0.5 ? -1 : 1);
    harm = {
      iv, tau: 0, life: 26 + rnd() * 10, clearing: 0, fadeT: 0, labelT: 0,
      fx: iv[0] * base, fy: iv[1] * base * (1 + det),
      px: rnd() * 6.283, py: rnd() * 6.283, qx: rnd() * 6.283, qy: rnd() * 6.283,
      ax: 470 + rnd() * 80, ay: 250 + rnd() * 45, ci: (rnd() * 3) | 0,
    };
  }
  function harmAt(h, tau, ph) {
    const d = Math.exp(-tau / (h.life * 1.25));        // the swing decays to ~45% before it ends
    const e = harmAmp;
    return [W / 2 + h.ax * d * e * (Math.sin(h.fx * tau + h.px + ph) + 0.22 * Math.sin(2 * h.fx * tau + h.qx)) / 1.22,
            H / 2 + h.ay * d * e * (Math.sin(h.fy * tau + h.py) + 0.22 * Math.sin(2 * h.fy * tau + h.qy + ph)) / 1.22];
  }
  function mHarmonograph(pool, w, dt, mv) {
    if (!paper) { paper = document.createElement('canvas'); paper.width = W; paper.height = H; px = paper.getContext('2d'); }
    if (!harm) newSwing();
    const h = harm, step = dt * mv;
    harmAmp = amp(A.energy, 0.35);
    const ns = Math.max(1, sprites.length), nsh = Math.max(1, lits.length);

    // The paper fades in coarse steps, not a sliver every frame: an 8-bit channel can't lose less
    // than one unit, so a tiny per-frame fade leaves permanent ghosts. The wipe between swings
    // clears whatever residue remains.
    h.fadeT += step;
    const wipe = h.clearing > 0;
    if (wipe || h.fadeT > 0.33) {
      px.globalCompositeOperation = 'destination-out';
      px.fillStyle = `rgba(0,0,0,${wipe ? 0.14 : 0.034})`;
      px.fillRect(0, 0, W, H);
      h.fadeT = 0;
    }

    if (wipe) {
      h.clearing -= step;
      if (h.clearing <= 0) { newSwing(); harm.labelT = 4; }
    } else {
      const t0 = h.tau; h.tau += step;
      if (h.tau > h.life) h.clearing = 1.4;
      px.globalCompositeOperation = 'lighter';
      for (let pen = 0; pen < 2; pen++) {
        const ph = pen * 1.5708;
        const [x1, y1] = harmAt(h, t0, ph), [x2, y2] = harmAt(h, h.tau, ph);
        const steps = Math.min(36, Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 2)));
        const soft = sprites[(h.ci + pen) % ns], core = lits[(h.ci + pen) % nsh];
        for (let j = 1; j <= steps; j++) {
          const [x, y] = harmAt(h, t0 + (h.tau - t0) * j / steps, ph);
          if (soft) { px.globalAlpha = 0.22; px.drawImage(soft, x - 5.5, y - 5.5, 11, 11); }
          if (core) { px.globalAlpha = Math.min(1, 0.75 * amp(A.treble, 0.5)); px.drawImage(core, x - 1.8, y - 1.8, 3.6, 3.6); }
        }
      }
      px.globalAlpha = 1;
    }

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = w;
    ctx.drawImage(paper, 0, 0);
    if (!wipe) {                                        // the glowing nibs, on top of their ink
      for (let pen = 0; pen < 2; pen++) {
        const [x, y] = harmAt(h, h.tau, pen * 1.5708), core = lits[(h.ci + pen) % nsh];
        const nib = 14 * (1 + A.beat * 0.9);
        if (core) { ctx.globalAlpha = 0.9 * w; ctx.drawImage(core, x - nib / 2, y - nib / 2, nib, nib); }
      }
    }
    // the interval, named briefly as each swing begins (top-left, mirroring the mode label)
    if (h.labelT > 0) {
      h.labelT -= dt;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = Math.max(0, Math.min(1, h.labelT, 4 - h.labelT)) * 0.7 * w;
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillText(`${h.iv[2]}  ·  ${h.iv[0]}:${h.iv[1]}`, 112, 74);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Halo ----------------------------------------------------------------------------------
  // The spectrum as a ring of light around the cover: 24 bands mirrored left and right, bass
  // meeting at the top and treble at the bottom (shorter bars there keep the titles clear), each
  // bar as long as its band is loud, with a falling peak cap. Every bar is the same pre-tinted
  // sprite blitted under a rotation — no strokes, which cost ~3ms a call on this panel.
  let haloBars = null, haloCaps = null;
  function buildHalo() {
    haloBars = pal.acc.map(c0 => {
      const c = lift(c0, 0.2), s2 = document.createElement('canvas'); s2.width = 128; s2.height = 24;
      const g = s2.getContext('2d'), col = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
      const lg = g.createLinearGradient(0, 0, 128, 0);              // base dim, tip bright
      lg.addColorStop(0, `rgba(${col},0.25)`); lg.addColorStop(0.85, `rgba(${col},0.95)`); lg.addColorStop(1, `rgba(${col},0.4)`);
      g.fillStyle = lg; g.fillRect(0, 4, 128, 16);
      const vg = g.createLinearGradient(0, 0, 0, 24);               // soft long edges
      vg.addColorStop(0, 'rgba(0,0,0,1)'); vg.addColorStop(0.3, 'rgba(0,0,0,0)'); vg.addColorStop(0.7, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,1)');
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = vg; g.fillRect(0, 0, 128, 24);
      return s2;
    });
    haloCaps = lits;
  }
  function mHalo(pool, w) {
    if (!haloBars || haloBars.src !== pal) { buildHalo(); haloBars.src = pal; }
    const cx = W / 2, cy = ART_CY, r0 = ART_SZ * 0.5 + 24, spin = Math.sin(tNow * 0.05) * 0.12;
    const nb = haloBars.length, nc = Math.max(1, haloCaps.length), bw = 15 + A.beat * 5;
    const textTop = ART_CY + ART_SZ / 2 + 12;           // bars pointing down stop above the title
    ctx.globalCompositeOperation = 'lighter';
    for (let side = -1; side <= 1; side += 2) {
      for (let b = 0; b < NB; b++) {
        const a = -Math.PI / 2 + spin + side * (b + 0.5) / NB * Math.PI;
        const c = Math.cos(a), sn = Math.sin(a);
        // the longest this bar can be: to the screen edge it points at (or the title block)
        let reach = Math.abs(c) > 1e-3 ? (W / 2 - 14) / Math.abs(c) : 1e4;
        if (sn < -1e-3) reach = Math.min(reach, (cy - 10) / (-sn * 0.86));
        else if (sn > 1e-3) reach = Math.min(reach, Math.max(r0 + 20, (textTop - cy) / (sn * 0.86)));
        const span = Math.max(20, reach - r0 - 10);
        const v = A.bands[b], len = 8 + Math.pow(v, 2.2) * span;
        ctx.setTransform(c, sn * 0.86, -sn, c * 0.86, cx, cy);     // a touch elliptical, like Bloom
        ctx.globalAlpha = (0.55 + v * 0.45) * w;
        ctx.drawImage(haloBars[b % nb], r0, -bw / 2, len, bw);
        const cap = haloCaps[b % nc];
        if (cap) { const pk = 8 + Math.pow(A.peaks[b], 2.2) * span; ctx.globalAlpha = 0.8 * w; ctx.drawImage(cap, r0 + pk + 4, -6, 12, 12); }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  // ---- Scope ---------------------------------------------------------------------------------
  // The waveform itself, bent into a ring around the cover — an oscilloscope trace that closes on
  // itself. The tap starts each capture at a rising zero-crossing so steady tones hold still;
  // samples are smoothed across neighbours and a little across frames, then stroked as a wide
  // soft pass and a thin bright core, with a second, fainter trace a quarter-turn behind.
  const scopeS = new Float32Array(NW);
  function scopeRing(r0, k, off, spin) {
    const N = NW * 2;
    ctx.beginPath();
    for (let j = 0; j <= N; j++) {
      const jj = j % N, i0 = jj < NW ? jj : N - 1 - jj;            // there and back: the loop closes
      const i = (i0 + off) % NW;
      const v = (scopeS[(i + NW - 1) % NW] + 2 * scopeS[i] + scopeS[(i + 1) % NW]) / 4;
      const a = spin + (j / N) * Math.PI * 2, r = r0 + v * k;
      const x = W / 2 + Math.cos(a) * r, y = ART_CY + Math.sin(a) * r * 0.86;
      if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
  }
  function mScope(pool, w, dt) {
    for (let i = 0; i < NW; i++) scopeS[i] += (A.wave[i] - scopeS[i]) * Math.min(1, dt * 45);
    const c0 = pal.acc[0] || [200, 220, 255], c1 = pal.acc[1] || c0;
    const k = 300 * (amp(A.energy, 0.8) + A.beat * 0.9);
    const spin = tNow * 0.06, r0 = ART_SZ * 0.5 + 58 + (A.bass - 0.5) * 70 + A.beat * 34;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    scopeRing(r0 + 30, k * 0.8, NW >> 2, -spin * 0.7);
    ctx.strokeStyle = `rgba(${c1[0] | 0},${c1[1] | 0},${c1[2] | 0},${(0.35 * w).toFixed(3)})`; ctx.lineWidth = 2; ctx.stroke();
    scopeRing(r0, k, 0, spin);
    ctx.strokeStyle = `rgba(${c0[0] | 0},${c0[1] | 0},${c0[2] | 0},${(0.22 * w).toFixed(3)})`; ctx.lineWidth = 10; ctx.stroke();
    const hi = lift(c0, 0.5);
    ctx.strokeStyle = `rgba(${hi[0] | 0},${hi[1] | 0},${hi[2] | 0},${(0.9 * w).toFixed(3)})`; ctx.lineWidth = 2.5 + A.beat * 2; ctx.stroke();
    scrimText(w * 0.75);                                // the trace now swings across the titles
    ctx.globalAlpha = 1;
  }

  // the dark pool behind the title block, shared by modes that draw right up to the text
  let kalScrim = null;
  function scrimText(w) {
    if (!kalScrim) {
      kalScrim = document.createElement('canvas'); kalScrim.width = kalScrim.height = 256;
      const g = kalScrim.getContext('2d'), rg = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      rg.addColorStop(0, 'rgba(0,0,0,0.78)'); rg.addColorStop(0.55, 'rgba(0,0,0,0.5)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
    }
    const ty = ART_CY + ART_SZ / 2 + 110;               // centre of the title/artist/album block
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = w;
    ctx.drawImage(kalScrim, W / 2 - 520, ty - 150, 1040, 300);
  }

  function renderMode(id, pool, w, dt, mv, k) {
    switch (id) {
      case 0: return mDrift(pool, w, dt, mv, k);
      case 1: return mOrbit(pool, w, dt, mv);
      case 2: return mAurora(pool, w);
      case 3: return mNebula(pool, w, dt, mv);
      case 4: return mStars(pool, w, dt, mv);
      case 5: return mRibbons(pool, w);
      case 6: return mLattice(pool, w, dt, mv);
      case 7: return mBloom(pool, w, dt, mv);
      case 8: return mRain(pool, w, dt, mv);
      case KAL: return mKaleido(pool, w);
      case MUR: return mMurmur(pool, w, dt);
      case GOL: return mGolden(pool, w);
      case HAR: return mHarmonograph(pool, w, dt, mv);
      case HALO: return mHalo(pool, w);
      case SCOPE: return mScope(pool, w, dt);
    }
  }

  function drawArt(cx, cy, size) {
    if (!artImg) return;
    if (glow) { const r = size * 1.15; ctx.drawImage(glow, cx - r, cy - r, r * 2, r * 2); }
    const x = cx - size / 2, y = cy - size / 2;
    ctx.save(); ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, size, size, 14); else ctx.rect(x, y, size, size);
    ctx.clip(); ctx.drawImage(artImg, x, y, size, size); ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, size, size, 14); else ctx.rect(x, y, size, size);
    ctx.stroke();
  }

  // Canvas text neither wraps nor clips, so a long title runs straight off both edges.
  // Keep every line inside a centred safe box; the title may use two lines, the rest one.
  function ellipsize(s, maxw) {
    if (ctx.measureText(s).width <= maxw) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(s.slice(0, mid) + '\u2026').width <= maxw) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo).trimEnd() + '\u2026';
  }

  function wrap2(s, maxw) {
    if (ctx.measureText(s).width <= maxw) return [s];
    const w = s.split(' ');
    let head = '', i = 0;
    for (; i < w.length; i++) {
      const next = head ? head + ' ' + w[i] : w[i];
      if (ctx.measureText(next).width > maxw) break;
      head = next;
    }
    if (!head) return [ellipsize(s, maxw)];            // a single unbreakable word
    const rest = w.slice(i).join(' ');
    return rest ? [head, ellipsize(rest, maxw)] : [head];
  }

  function drawInfo(st) {
    ctx.textAlign = 'center';
    const maxw = W * 0.76;                              // leaves ~12% each side, clear of overscan
    let y = ART_CY + ART_SZ / 2 + 58;
    ctx.fillStyle = '#fff';
    ctx.font = '600 40px system-ui, sans-serif';        // set before measuring: measureText uses it
    for (const line of wrap2(st.title || '', maxw)) {
      ctx.fillText(line, W / 2, y);
      y += 46;
    }
    y -= 6;                                             // lines advance 46; artist sits 40 below the last
    ctx.fillStyle = 'rgba(255,255,255,0.74)';
    ctx.font = '27px system-ui, sans-serif';
    ctx.fillText(ellipsize(st.artist || '', maxw), W / 2, y);
    // Singles often name the album after the track, and playing an album sets the context to
    // the album name — so both lines can echo something already on screen. Show each only once.
    const norm = x => (x || '').trim().toLowerCase();
    const showAlbum = st.album && norm(st.album) !== norm(st.title);
    const showCtx = st.context && norm(st.context) !== norm(st.album) && norm(st.context) !== norm(st.title);
    if (showAlbum) {
      y += 33;
      ctx.fillStyle = 'rgba(255,255,255,0.46)';
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillText(ellipsize(st.album, maxw), W / 2, y);
    }
    if (showCtx) {
      y += 30;
      const a = pal.acc[0] || [180, 200, 230];
      ctx.fillStyle = `rgba(${a[0] | 0},${a[1] | 0},${a[2] | 0},0.72)`;
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText(ellipsize(st.context, maxw), W / 2, y);
    }
  }

  function nextAuto(i) {
    do i = (i + 1) % MODES.length; while (AUDIO_ONLY.has(i) && A.mix < 0.5);
    return i;
  }

  function frame(ts) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (ts - lastDraw < 1000 / FPS - 1) return;      // frame cap
    lastDraw = ts;
    const st = opts.state() || {};
    if (!tPrev) tPrev = ts;
    let dt = (ts - tPrev) / 1000; tPrev = ts;
    if (dt > 0.1) dt = 0.1;
    updateAudio(dt, ts);
    // paused: keep drifting slowly, never freeze. Playing: louder passages move faster.
    const moving = st.paused ? 0.22 : amp(A.energy, 0.7);
    tNow += dt * moving;

    const id = st.uri || '';
    if (id && id !== lastTrack) {
      lastTrack = id;
      seed = hash(id) || 1;
      if (st.artUrl && st.artUrl !== artUrl) {
        artUrl = st.artUrl;
        palette(st.artUrl).then(p => { prevPal = pal || p; pal = p; palMix = 0; artImg = p.img; buildSprites(p); }).catch(() => {});
      }
    }
    if (!pal) return;
    if (palMix < 1) palMix = Math.min(1, palMix + dt * 0.8);

    const bg = prevPal ? pal.bg.map((v, i) => lerp(prevPal.bg[i], v, palMix)) : pal.bg;
    const prog = st.duration ? Math.min(1, st.position / st.duration) : 0;

    // Auto holds a mode, then cross-fades into the next by drawing both with complementary
    // weights — no offscreen buffers; every mode scales its own alphas by w.
    let curMode = mode, nxtMode = -1, mixW = 0;
    if (mode === AUTO) {
      autoT += dt * moving;
      if (autoT >= HOLD + FADE) {
        autoT -= HOLD + FADE;
        autoIdx = nextAuto(autoIdx);
        const sw = poolA; poolA = poolB; poolB = sw;   // the faded-in pool becomes current
        autoNextReady = -1; modeUntil = tNow + 2;
      }
      curMode = autoIdx;
      if (autoT > HOLD) {
        nxtMode = nextAuto(autoIdx);
        mixW = (autoT - HOLD) / FADE;
        if (autoNextReady !== nxtMode) { initFor(nxtMode, poolB); autoNextReady = nxtMode; }
      }
    }
    const trail = nxtMode >= 0 ? lerp(TRAIL[curMode], TRAIL[nxtMode], mixW) : TRAIL[curMode];

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${bg[0] | 0},${bg[1] | 0},${bg[2] | 0},${trail})`;
    ctx.fillRect(0, 0, W, H);

    const k = 0.75 + prog * 0.8;
    renderMode(curMode, poolA, nxtMode >= 0 ? 1 - mixW : 1, dt, moving, k);
    if (nxtMode >= 0) renderMode(nxtMode, poolB, mixW, dt, moving, k);

    ctx.globalCompositeOperation = 'source-over';
    drawArt(W / 2, ART_CY, ART_SZ * (1 + Math.sin(tNow * 0.55) * 0.013));   // the cover stays still: no beat pulse
    drawInfo(st);

    // progress line + position marker; shows the seek target while scrubbing
    const barX = W * 0.18, barW = W * 0.64, barY = H - 42;
    const seeking = seekPreview != null;
    // ease toward the target so discrete presses glide rather than snapping in chunks
    if (seeking) seekShown = seekShown == null ? st.position : seekShown + (seekPreview - seekShown) * Math.min(1, dt * 7);
    else seekShown = null;
    const shown = seeking ? seekShown : st.position;
    const shownProg = st.duration ? Math.max(0, Math.min(1, shown / st.duration)) : 0;
    const a1 = pal.acc[0] || [255, 255, 255];
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(barX, barY, barW, 3);
    ctx.fillStyle = rgb(a1);
    ctx.fillRect(barX, barY, barW * shownProg, 3);
    ctx.beginPath();
    ctx.arc(barX + barW * shownProg, barY + 1.5, seeking ? 11 : 7, 0, Math.PI * 2);
    ctx.fillStyle = seeking ? '#ffffff' : rgb(a1);
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.38)'; ctx.stroke();
    ctx.font = '19px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = seeking ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.50)';
    ctx.fillText(mmss(shown), barX, barY - 16);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.50)';
    ctx.fillText(mmss(st.duration), barX + barW, barY - 16);
    if (st.paused && !seeking) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText('Paused', W / 2, barY - 16);
    }
    if (flashT > 0) {                                   // ♥ etc. over the cover, rising and fading
      flashT -= dt;
      const f = Math.max(0, flashT / 1.3);
      ctx.globalAlpha = Math.min(1, f * 2);
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.font = `600 ${96 + (1 - f) * 40 | 0}px system-ui, sans-serif`;
      ctx.fillText(flashTxt, W / 2, ART_CY + 34 - (1 - f) * 30);
      ctx.globalAlpha = 1;
    }
    const audioMode = mode === AUTO ? -1 : mode;
    if ((AUDIO_ONLY.has(audioMode) && A.mix < 0.3) || (A.state === 'denied' && hintT > 0)) {
      if (hintT > 0) hintT -= dt;
      ctx.textAlign = 'left'; ctx.font = '20px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(A.state === 'denied' ? 'Audio access declined — the visualiser can’t hear the music'
        : A.state === 'unavailable' ? 'Audio tap unavailable on this TV' : (st.paused ? 'Paused' : 'Listening…'), 112, 74);
    }
    // intensity, briefly, after a 1 / 3 press — in the mode name's place
    const lvA = Math.min(1, 2 - (ts - levelAt) / 1000);
    if (lvA > 0) {
      ctx.globalAlpha = lvA;
      const dx = 24, x1 = W - 119, x0 = x1 - dx * 4, y = 66;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath(); ctx.arc(x0 + i * dx, y, 7, 0, Math.PI * 2);
        if (i < level) { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill(); }
        else { ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.stroke(); }
      }
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '600 24px system-ui, sans-serif';
      ctx.fillText('Intensity', x0 - 20, 74);
      ctx.globalAlpha = 1;
    } else if (tNow < modeUntil) {                     // mode name, briefly, after a cycle
      ctx.globalAlpha = Math.min(1, modeUntil - tNow);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '600 24px system-ui, sans-serif';
      ctx.fillText(mode === AUTO ? `Auto · ${MODES[autoIdx]}` : MODES[mode], W - 112, 74);
      ctx.globalAlpha = 1;
    }
  }

  window.VIZ = {
    start(o) {
      opts = o;
      const host = document.getElementById('viz');
      if (!cv) {
        cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        host.appendChild(cv);
        ctx = cv.getContext('2d', { alpha: false });
        poolA = mkPool(NPART); poolB = mkPool(NPART);
      }
      seed = hash(lastTrack || 'x') || 1;
      initFor(mode === AUTO ? autoIdx : mode, poolA);
      ctx.fillStyle = '#07070b'; ctx.fillRect(0, 0, W, H);
      host.hidden = false;
      running = true; tPrev = 0;
      hintT = 6;
      try {
        if (window.AudioBridge) { AudioBridge.onmessage = e => onAudio(e.data); AudioBridge.postMessage('on'); }
        else A.state = 'unavailable';
      } catch (e) { A.state = 'unavailable'; }
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      try { window.AudioBridge?.postMessage('off'); } catch (e) {}
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      const host = document.getElementById('viz');
      if (host) host.hidden = true;
    },
    cycle(d) {
      mode = (mode + d + AUTO + 1) % (AUTO + 1);   // AUTO sits past the last real mode
      try { localStorage.viz_mode = mode === AUTO ? 'Auto' : MODES[mode]; } catch (e) {}
      modeUntil = tNow + 2; levelAt = -1e9;
      if (mode === AUTO) { autoT = 0; autoIdx = 0; autoNextReady = -1; }
      initFor(mode === AUTO ? autoIdx : mode, poolA);
      console.log('[viz] mode:', this.modeName());
      return this.modeName();
    },
    modeName: () => (mode === AUTO ? 'Auto' : MODES[mode]),
    intensity(d = 0) {
      level = Math.min(5, Math.max(1, level + d));
      try { localStorage.viz_intensity = String(level); } catch (e) {}
      levelAt = performance.now(); modeUntil = 0;
      console.log('[viz] intensity:', level);
      return level;
    },
    setSeekPreview(ms) { seekPreview = ms; },
    flash(txt) { flashTxt = txt; flashT = 1.3; },
    _raw: () => ({ db: [...R.db].map(v => +v.toFixed(1)), lo: [...R.lo].map(v => +v.toFixed(1)), hi: [...R.hi].map(v => +v.toFixed(1)),
                   lv: +R.lv.toFixed(3), lvAvg: +R.lvAvg.toFixed(3), beats: R.beats, fluxDev: +R.fluxDev.toFixed(2) }),
    audio: () => ({ state: A.state, mix: +A.mix.toFixed(2), beat: +A.beat.toFixed(2), bass: +A.bass.toFixed(2),
                    mid: +A.mid.toFixed(2), treble: +A.treble.toFixed(2), energy: +A.energy.toFixed(2), rms: R.rms, level }),
  };
})();
