'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────
const CFG = {
  LANE_W:        90,
  LANE_COUNT:    4,
  HWY_SPEED:     2.4,
  HIT_Y_RATIO:   0.87,
  NOTE_H:        22,
  NOTE_R:        7,
  TAIL_W:        30,
  PERFECT_MS:    65,
  GOOD_MS:       130,
  MISS_MS:       210,
  HP_HIT:        0.022,
  HP_MISS:       0.09,
  HP_HOLD_SEC:   0.018,
  KEYS:          ['d','f','j','k'],
  PERSP_TOP:     0.20,  // highway width ratio at vanishing point — 0.20 = 1:5 top:bottom
  RUNWAY:        0.85,  // seconds of note visibility before audio starts
  COLORS: [
    { main:'#FFD700', shine:'#FFFACD', dark:'#7A4800', glow:'rgba(255,215,0,.6)' },
    { main:'#FF9500', shine:'#FFE0A0', dark:'#7A3800', glow:'rgba(255,149,0,.6)'  },
    { main:'#FFD700', shine:'#FFFACD', dark:'#7A4800', glow:'rgba(255,215,0,.6)' },
    { main:'#FF9500', shine:'#FFE0A0', dark:'#7A3800', glow:'rgba(255,149,0,.6)'  },
  ],
};

// ─── State ────────────────────────────────────────────────────────────────────
// 'idle' | 'loading' | 'countdown' | 'playing' | 'dying' | 'ended'
let state = 'idle';
let chart = null;
let currentDifficulty = 'medium';
let currentMode = 'original';
let dyingTs = null;    // performance.now() when health first hit 0
let winningTs = null;  // performance.now() when all notes settled
let gameWallStart = 0; // performance.now() when the game loop started

// per-game runtime
let notes = [], particles = [];
let score = 0, combo = 0, maxCombo = 0, health = 0;
let totalNotes = 0, hitCnt = 0, missCnt = 0, perfCnt = 0, goodCnt = 0;

// input
let keysHeld = {}, laneHeld = [false,false,false,false];
let listenersOn = false;

// canvas
let canvas, ctx, rafId = null, lastTs = 0;

// playback
let audioEl = null;
let selectedFile = null;

// ─── DOM shorthand ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Perspective helpers ──────────────────────────────────────────────────────
// scale: 1.0 at hitY, PERSP_TOP at y=0 (vanishing point)
function perspScale(y, hitY) {
  return CFG.PERSP_TOP + (1 - CFG.PERSP_TOP) * Math.max(0, Math.min(1, y / hitY));
}
// X center of lane `lane` at canvas height `y`
function laneX(lane, y, hitY) {
  const norm = (lane + 0.5) / CFG.LANE_COUNT - 0.5; // −0.375 … +0.375
  return canvas.width / 2 + norm * canvas.width * perspScale(y, hitY);
}
// X position of lane edge `edge` (0=left wall, 1-3=dividers, 4=right wall) at height `y`
function laneEdgeX(edge, y, hitY) {
  const norm = edge / CFG.LANE_COUNT - 0.5; // −0.5 … +0.5
  return canvas.width / 2 + norm * canvas.width * perspScale(y, hitY);
}

// ─── Start-screen background particles ───────────────────────────────────────
(function bgCanvas() {
  const bc = $('bg-canvas'), bx = bc.getContext('2d');
  const pts = Array.from({length:55}, () => ({
    x: Math.random(), y: Math.random(),
    vx:(Math.random()-.5)*.00014, vy:(Math.random()-.5)*.00014,
    r:.6+Math.random()*1.4, phase: Math.random()*Math.PI*2,
  }));
  function resize() { bc.width=innerWidth; bc.height=innerHeight; }
  resize(); addEventListener('resize', resize);
  (function frame(t) {
    bc.width = bc.width; // clear
    pts.forEach(p => {
      p.x+=p.vx; p.y+=p.vy;
      if(p.x<0)p.x=1; if(p.x>1)p.x=0;
      if(p.y<0)p.y=1; if(p.y>1)p.y=0;
      bx.beginPath();
      bx.arc(p.x*bc.width, p.y*bc.height, p.r, 0, Math.PI*2);
      bx.fillStyle = `rgba(255,215,0,${.25+.2*Math.sin(t/1600+p.phase)})`;
      bx.fill();
    });
    requestAnimationFrame(frame);
  })(0);
})();

// ─── Playback ─────────────────────────────────────────────────────────────────
function playbackPlay() {
  if (!audioEl) return;
  audioEl.currentTime = 0;
  audioEl.play().catch(()=>{});
}
function playbackPause() {
  if (audioEl) audioEl.pause();
}
function fadeOutAudio(durationMs) {
  const start = performance.now();
  const origVol = audioEl ? audioEl.volume : 1;
  (function tick() {
    const p = Math.min(1, (performance.now() - start) / durationMs);
    if (audioEl) audioEl.volume = origVol * (1 - p);
    if (p < 1) requestAnimationFrame(tick);
  })();
}
function beginWinning(fadeMs) {
  if (state !== 'playing') return;
  state = 'winning';
  winningTs = performance.now();
  if (fadeMs > 0) fadeOutAudio(fadeMs);
}

function now() {
  if (audioEl && audioEl.currentTime > 0.01) return audioEl.currentTime;
  return (performance.now() - gameWallStart) / 1000 - CFG.RUNWAY;
}

// ─── Countdown ────────────────────────────────────────────────────────────────
function runCountdown() {
  return new Promise(resolve => {
    const overlay = $('countdown-overlay');
    const numEl   = $('countdown-num');
    overlay.style.display = 'flex';
    const steps = ['3','2','1','GO!'];
    let i = 0;
    function next() {
      numEl.textContent = steps[i];
      numEl.classList.remove('pop');
      void numEl.offsetWidth;       // force reflow so animation restarts
      numEl.classList.add('pop');
      i++;
      if (i < steps.length) setTimeout(next, 850);
      else setTimeout(() => { overlay.style.display='none'; resolve(); }, 850);
    }
    next();
  });
}

// ─── Difficulty & mode selectors ─────────────────────────────────────────────
const DIFF_HP = {
  easy:    { HP_MISS: 0.04, HP_HIT: 0.030, HP_HOLD_SEC: 0.020 },
  medium:  { HP_MISS: 0.09, HP_HIT: 0.022, HP_HOLD_SEC: 0.018 },
  hard:    { HP_MISS: 0.16, HP_HIT: 0.018, HP_HOLD_SEC: 0.015 },
  extreme: { HP_MISS: 0.28, HP_HIT: 0.012, HP_HOLD_SEC: 0.010 },
};

document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('diff-btn-active'));
    btn.classList.add('diff-btn-active');
    currentDifficulty = btn.dataset.diff;
  });
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('mode-btn-active'));
    btn.classList.add('mode-btn-active');
    currentMode = btn.dataset.mode;
  });
});

function applyDifficulty(rawNotes) {
  // Hard and extreme get all notes; extreme is just punishing on health
  if (currentDifficulty === 'hard' || currentDifficulty === 'extreme') return rawNotes;

  const MIN_GAP = currentDifficulty === 'easy' ? 0.35 : 0.13;
  const out = [];
  let lastTime = -999;
  for (const n of rawNotes) {
    if (n.time - lastTime < MIN_GAP) continue;
    if (currentDifficulty === 'easy' && out.length && n.time - out[out.length - 1].time < 0.08) continue;
    out.push(n);
    lastTime = n.time;
  }
  return out;
}

// Hugging Face Space API — used only for stem separation (VOCALS/BASS/DRUMS/GUITAR)
// Update this URL after creating your HF Space: https://huggingface.co/spaces/YOUR_USERNAME/guitargod-stems
const API_BASE = 'https://NotAmen-guitargod-stems.hf.space';

// ─── Client-side audio analysis ──────────────────────────────────────────────
const ANALYSIS_SR  = 16000;
const ANALYSIS_HOP = 512;
const MAX_ANALYSIS_SECS = 300; // 5 min cap

async function renderBandEnergy(audioBuffer, loHz, hiHz) {
  const sr  = audioBuffer.sampleRate;
  const ctx = new OfflineAudioContext(1, audioBuffer.length, sr);
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  const hi = ctx.createBiquadFilter();
  hi.type = 'highpass'; hi.frequency.value = loHz; hi.Q.value = 0.707;
  const lo = ctx.createBiquadFilter();
  lo.type = 'lowpass';  lo.frequency.value = Math.min(hiHz, sr / 2 - 1); lo.Q.value = 0.707;
  src.connect(hi); hi.connect(lo); lo.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

function estimateBPM(onsetEnv, fps) {
  const minLag = Math.round(fps * 60 / 200);
  const maxLag = Math.round(fps * 60 / 60);
  let bestLag = minLag, bestCorr = -Infinity;
  const n = onsetEnv.length;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < n - lag; i++) c += onsetEnv[i] * onsetEnv[i + lag];
    if (c > bestCorr) { bestCorr = c; bestLag = lag; }
  }
  return 60 * fps / bestLag;
}

// Per-mode band weights: [bass, low-mid, high-mid, treble]
// Controls which frequency ranges drive ONSET DETECTION (not lane assignment)
const MODE_WEIGHTS = {
  original: [1.0, 1.0, 1.0, 1.0],
  vocals:   [0.1, 1.5, 1.5, 0.3],
  bass:     [2.0, 0.3, 0.1, 0.0],
  drums:    [1.5, 0.8, 0.8, 1.2],
  guitar:   [0.2, 1.2, 2.0, 1.0],
};

// Per-mode analysis parameters
const MODE_PARAMS = {
  original: { minGap: 0.080, laneGap: 0.100, sPct: 0.50, hDecay: 0.20, maxHold: 1.2 },
  vocals:   { minGap: 0.100, laneGap: 0.110, sPct: 0.42, hDecay: 0.40, maxHold: 2.2 },
  bass:     { minGap: 0.090, laneGap: 0.100, sPct: 0.38, hDecay: 0.28, maxHold: 1.4 },
  drums:    { minGap: 0.050, laneGap: 0.065, sPct: 0.46, hDecay: 0.18, maxHold: 0.10 },
  guitar:   { minGap: 0.075, laneGap: 0.085, sPct: 0.42, hDecay: 0.33, maxHold: 1.8 },
};

async function analyzeFile(arrayBuffer, mode = 'original') {
  const mp = MODE_PARAMS[mode] || MODE_PARAMS.original;
  setStatus('DECODING AUDIO…');
  const initCtx = new AudioContext();
  const fullBuffer = await initCtx.decodeAudioData(arrayBuffer);
  await initCtx.close();

  // Resample to ANALYSIS_SR and trim to MAX_ANALYSIS_SECS (mono)
  const targetSamples = Math.min(
    Math.floor(fullBuffer.duration * ANALYSIS_SR),
    ANALYSIS_SR * MAX_ANALYSIS_SECS
  );
  const offCtx = new OfflineAudioContext(1, targetSamples, ANALYSIS_SR);
  const src = offCtx.createBufferSource();
  src.buffer = fullBuffer;
  src.connect(offCtx.destination);
  src.start();
  const mono = await offCtx.startRendering();

  const data = mono.getChannelData(0);
  const sr   = ANALYSIS_SR;
  const hop  = ANALYSIS_HOP;
  const fps  = sr / hop;
  const duration = mono.duration;
  const numFrames = Math.floor(data.length / hop);

  // Per-frame RMS (noise gate)
  const rms = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    const s = i * hop, e = Math.min(s + hop, data.length);
    for (let j = s; j < e; j++) sum += data[j] * data[j];
    rms[i] = Math.sqrt(sum / (e - s));
  }
  const rmsMax = Math.max.apply(null, rms) + 1e-9;

  // Four frequency bands → four lanes
  setStatus('ANALYZING FREQUENCIES…');
  const bandDefs = [[40,250],[250,1000],[1000,4000],[4000,7500]];
  const bandRms = await Promise.all(bandDefs.map(async ([lo, hi]) => {
    const buf = await renderBandEnergy(mono, lo, hi);
    const ch  = buf.getChannelData(0);
    const fr  = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      let sum = 0;
      const s = i * hop, e = Math.min(s + hop, ch.length);
      for (let j = s; j < e; j++) sum += ch[j] * ch[j];
      fr[i] = Math.sqrt(sum / (e - s));
    }
    return fr;
  }));

  // Onset envelope = positive spectral flux summed across bands, weighted by mode
  const weights = MODE_WEIGHTS[mode] || MODE_WEIGHTS.original;
  const onsetEnv = new Float32Array(numFrames);
  for (let b = 0; b < 4; b++) {
    const br = bandRms[b];
    const w  = weights[b];
    if (w === 0) continue;
    for (let i = 1; i < numFrames; i++) {
      const d = br[i] - br[i - 1];
      if (d > 0) onsetEnv[i] += d * w;
    }
  }

  const bpm = estimateBPM(onsetEnv, fps);

  // Adaptive threshold peak picking
  setStatus('DETECTING ONSETS…');
  const winFrames = Math.round(0.3 * fps);
  const adaptive  = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0, cnt = 0;
    const a = Math.max(0, i - winFrames), b2 = Math.min(numFrames - 1, i + winFrames);
    for (let j = a; j <= b2; j++) { sum += onsetEnv[j]; cnt++; }
    adaptive[i] = sum / cnt;
  }

  const NOISE_GATE = 0.06;
  const MIN_GAP    = Math.round(mp.minGap * fps);
  const onsetFrames = [];
  let lastPick = -MIN_GAP;
  for (let i = 1; i < numFrames - 1; i++) {
    if (onsetEnv[i] > adaptive[i] * 1.3 &&
        onsetEnv[i] > onsetEnv[i - 1] &&
        onsetEnv[i] >= onsetEnv[i + 1] &&
        rms[i] / rmsMax >= NOISE_GATE &&
        i - lastPick >= MIN_GAP) {
      onsetFrames.push(i);
      lastPick = i;
    }
  }

  // Strength threshold by mode percentile
  const sorted = onsetFrames.map(f => onsetEnv[f]).sort((a, b) => a - b);
  const strengthThresh = sorted[Math.floor(sorted.length * mp.sPct)] || 0;

  // Spectral centroid → lane by quartile (guarantees all 4 lanes are used)
  const BAND_CENTERS = [145, 625, 2500, 5750];
  const centroids = onsetFrames.map(f => {
    let num = 0, den = 0;
    for (let b = 0; b < 4; b++) { const e = bandRms[b][f]; num += BAND_CENTERS[b] * e; den += e; }
    return den > 1e-9 ? num / den : BAND_CENTERS[1];
  });
  const sortedC = [...centroids].sort((a, b) => a - b);
  const q25 = sortedC[Math.floor(sortedC.length * 0.25)] ?? 0;
  const q50 = sortedC[Math.floor(sortedC.length * 0.50)] ?? 0;
  const q75 = sortedC[Math.floor(sortedC.length * 0.75)] ?? 0;

  // Build note chart
  setStatus('MAPPING NOTES…');
  const notes = [];
  const lastLaneTime = [-999, -999, -999, -999];
  let lastAnyTime = -999;
  const HOLD_MIN = 0.50;

  for (let i = 0; i < onsetFrames.length; i++) {
    const f = onsetFrames[i];
    const time = f * hop / sr;
    if (onsetEnv[f] < strengthThresh) continue;
    if (time - lastAnyTime < mp.minGap * 0.5) continue;

    // Lane by spectral centroid quartile (pitch-based, ensures 4-lane spread)
    const c = centroids[i];
    const preferred = c <= q25 ? 0 : c <= q50 ? 1 : c <= q75 ? 2 : 3;

    let chosen = null;
    for (let off = 0; off < 4; off++) {
      const lane = (preferred + off) % 4;
      if (time - lastLaneTime[lane] >= mp.laneGap) { chosen = lane; break; }
    }
    if (chosen === null) continue;

    // Hold: dominant weighted band drives sustain detection
    let holdBand = 0, holdMaxE = -1;
    for (let b = 0; b < 4; b++) {
      const e = bandRms[b][f] * weights[b];
      if (e > holdMaxE) { holdMaxE = e; holdBand = b; }
    }
    let holdDur = 0;
    const db = bandRms[holdBand];
    const oe = db[f] + 1e-9;

    // Only consider holds if the onset is strong enough and in sustaining frequencies
    const onsetStrength = onsetEnv[f];
    const avgOnsetStrength = sorted[Math.floor(sorted.length * 0.7)] || 0; // 70th percentile
    const isSustainingBand = holdBand === 1 || holdBand === 2; // Mid frequencies more likely to sustain

    if (onsetStrength >= avgOnsetStrength && isSustainingBand && oe > rms[f] * 0.8) {
      const lookEnd = Math.min(f + Math.round(mp.maxHold * fps), numFrames - 1);
      let sustainedFrames = 0;
      let totalFrames = 0;

      for (let k = f + 1; k <= lookEnd; k++) {
        totalFrames++;
        if (db[k] / oe >= mp.hDecay) {
          sustainedFrames++;
        } else {
          // Allow brief dips but require overall sustain
          if (sustainedFrames / totalFrames < 0.6) break;
        }
        const cand = (k - f) * hop / sr;
        if (cand >= HOLD_MIN && sustainedFrames / totalFrames >= 0.7) {
          holdDur = cand;
        }
      }
    }

    notes.push({ time, lane: chosen, duration: holdDur, type: holdDur >= HOLD_MIN ? 'hold' : 'tap' });
    lastLaneTime[chosen] = time + (holdDur >= HOLD_MIN ? holdDur + 0.08 : 0);
    lastAnyTime = time;
  }

  return { bpm, duration, notes };
}

// ─── Load flow (from start screen) ───────────────────────────────────────────
function setStatus(msg) { $('status-msg').textContent = msg; }

const dropZone = $('drop-zone');
const fileInput = $('file-input');

function setFile(file) {
  if (!file) return;
  selectedFile = file;
  const name = file.name.replace(/\.[^.]+$/, '');
  $('drop-zone-text').textContent = name;
  dropZone.classList.add('has-file');
  $('shred-btn').disabled = false;
}

dropZone.addEventListener('click',     ()  => fileInput.click());
fileInput.addEventListener('change',   e   => setFile(e.target.files[0]));
dropZone.addEventListener('dragover',  e   => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  setFile(e.dataTransfer.files[0]);
});

$('shred-btn').addEventListener('click', () => {
  if (selectedFile) onSubmitFile(selectedFile);
});

async function onSubmitFile(file) {
  if (!file || state === 'loading') return;
  state = 'loading';
  $('shred-btn').disabled = true;

  const title = file.name.replace(/\.[^.]+$/, '');
  let chartData, audioUrl;

  try {
    if (currentMode === 'original') {
      // Fully client-side
      const arrayBuffer = await file.arrayBuffer();
      chartData = await analyzeFile(arrayBuffer, 'original');
      audioUrl  = URL.createObjectURL(file);
    } else {
      // Stem separation via Render API → analyze stem client-side
      setStatus('SEPARATING STEMS — MAY TAKE A MINUTE…');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', currentMode);
      let res;
      try {
        res = await fetch(`${API_BASE}/separate`, { method: 'POST', body: fd });
      } catch {
        setStatus('STEM SERVER UNREACHABLE');
        goIdle(); return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setStatus(`ERROR: ${(err.error || 'STEM FAILED').toUpperCase()}`);
        goIdle(); return;
      }
      const stemBlob = await res.blob();
      audioUrl = URL.createObjectURL(file);
      const stemBuffer = await stemBlob.arrayBuffer();
      chartData = await analyzeFile(stemBuffer, currentMode);
    }
  } catch(e) {
    setStatus(`ERROR: ${String(e).toUpperCase().slice(0, 80)}`);
    goIdle(); return;
  }

  chart = { ...chartData, audioUrl, title, uploader: '', mode: currentMode };
  setStatus(`${applyDifficulty(chart.notes).length} NOTES — LOADING`);
  await beginGame(false);
}

function goIdle() {
  state = 'idle';
  $('shred-btn').disabled = !selectedFile;
}

// ─── Result screen buttons ────────────────────────────────────────────────────
$('play-again-btn').addEventListener('click', async () => {
  if (!chart) return;
  await beginGame(true); // true = replay same song
});

$('new-song-btn').addEventListener('click', () => {
  goIdle();
  showScreen('screen-start');
});

// ─── Begin game ───────────────────────────────────────────────────────────────
async function beginGame(isReplay) {
  // Fully tear down any previous session
  stopLoop();
  removeListeners();
  playbackPause();

  // Reset game state — apply difficulty filter to raw chart
  const filteredNotes = applyDifficulty(chart.notes);
  notes = filteredNotes.map((n,i) => ({
    ...n, id:i, hit:false, missed:false, holdActive:false,
  }));
  particles = [];
  score=0; combo=0; maxCombo=0; health=0.75;
  totalNotes=filteredNotes.length; hitCnt=0; missCnt=0; perfCnt=0; goodCnt=0;
  keysHeld={}; laneHeld.fill(false);
  dyingTs = null; winningTs = null;

  // Apply per-difficulty health values
  const dhp = DIFF_HP[currentDifficulty] ?? DIFF_HP.medium;
  CFG.HP_MISS     = dhp.HP_MISS;
  CFG.HP_HIT      = dhp.HP_HIT;
  CFG.HP_HOLD_SEC = dhp.HP_HOLD_SEC;

  showScreen('screen-game');
  $('song-title-hud').textContent = chart.title    || '';
  $('np-title').textContent       = chart.title    || '';
  $('np-artist').textContent      = chart.uploader || '';
  updateHUD();

  // Size canvas to fill the highway column
  canvas = $('highway');
  ctx    = canvas.getContext('2d');
  canvas.width  = Math.round($('highway-col').offsetWidth * 2 / 3);
  canvas.height = window.innerHeight - 64 - 46;  // hud 64px + keys 46px
  CFG.LANE_W    = Math.floor(canvas.width / CFG.LANE_COUNT);
  $('strike-keys').style.width = canvas.width + 'px';

  audioEl = new Audio(chart.audioUrl);
  audioEl.onended = () => { if (state === 'playing') beginWinning(0); };

  state = 'countdown';
  await runCountdown();

  // Start the game loop immediately so notes fall during the runway
  state = 'playing';
  gameWallStart = performance.now();
  lastTs = gameWallStart;
  rafId = requestAnimationFrame(loop);
  addListeners();

  // Give the player a visual runway before audio hits
  await sleep(CFG.RUNWAY * 1000);
  playbackPlay();
}

// ─── Game loop ────────────────────────────────────────────────────────────────
function loop(ts) {
  if (state !== 'playing' && state !== 'dying' && state !== 'winning') return;
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  const t = now();
  update(dt, t);
  render(t);
  rafId = requestAnimationFrame(loop);
}

function stopLoop() {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
}

// ─── Update ───────────────────────────────────────────────────────────────────
function update(dt, t) {
  // Dying transition
  if (state === 'dying') {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 220 * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    if (performance.now() - dyingTs > 1950) endGame(true);
    return;
  }

  // Winning transition — fade is already playing, just tick particles then show results
  if (state === 'winning') {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 220 * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    if (performance.now() - winningTs > 1500) endGame(false);
    return;
  }

  let allSettled = true;

  for (const n of notes) {
    // Already fully settled
    if (n.missed && !n.holdActive) continue;
    if (n.hit && !n.holdActive) continue;

    if (!n.hit && !n.missed) {
      allSettled = false;
      if (t - n.time > CFG.MISS_MS / 1000) {
        n.missed = true;
        registerMiss();
      }
      continue;
    }

    // Active hold ─ key must stay pressed
    if (n.hit && n.holdActive) {
      allSettled = false;
      if (t >= n.time + n.duration) {
        // Completed hold
        n.holdActive = false;
        score += 30 * multiplier();
        health = Math.min(1, health + 0.015);
        updateHUD();
      } else if (!laneHeld[n.lane]) {
        // Released too early
        n.holdActive = false;
        registerMiss();
      } else {
        // Drip score while holding
        score += Math.floor(20 * dt * multiplier());
        health = Math.min(1, health + CFG.HP_HOLD_SEC * dt);
        updateHUD();
      }
    }
  }

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 220 * dt;
    p.life -= p.decay * dt;
    if (p.life <= 0) particles.splice(i, 1);
  }

  if (allSettled && t > 1.5) beginWinning(1400);
}

function multiplier() { return Math.min(10, Math.max(1, 1 + Math.floor(combo / 10))); }

// ─── Input ────────────────────────────────────────────────────────────────────
function addListeners() {
  if (listenersOn) return;
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup',   onKeyUp);
  listenersOn = true;
}
function removeListeners() {
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup',   onKeyUp);
  listenersOn = false;
  keysHeld = {}; laneHeld.fill(false);
  CFG.KEYS.forEach(k => $(`skey-${k}`)?.classList.remove('lit'));
}

function onKeyDown(e) {
  if (e.repeat) return;
  const key = e.key.toLowerCase();
  if (keysHeld[key]) return;
  keysHeld[key] = true;
  const lane = CFG.KEYS.indexOf(key);
  if (lane === -1) return;
  laneHeld[lane] = true;
  $(`skey-${key}`).classList.add('lit');
  if (state === 'playing') tryHit(lane);
}

function onKeyUp(e) {
  const key = e.key.toLowerCase();
  keysHeld[key] = false;
  const lane = CFG.KEYS.indexOf(key);
  if (lane === -1) return;
  laneHeld[lane] = false;
  $(`skey-${key}`).classList.remove('lit');
}

// ─── Hit detection ────────────────────────────────────────────────────────────
function tryHit(lane) {
  const t = now();
  let best = null, bestDist = Infinity;
  for (const n of notes) {
    if (n.hit || n.missed || n.lane !== lane) continue;
    const d = Math.abs(n.time - t) * 1000;
    if (d < CFG.MISS_MS && d < bestDist) { bestDist = d; best = n; }
  }
  if (!best) return;

  best.hit = true;
  if (best.type === 'hold') best.holdActive = true;

  registerHit(bestDist <= CFG.PERFECT_MS ? 'PERFECT' : 'GOOD', lane);
}

function registerHit(quality, lane) {
  hitCnt++;
  score += (quality === 'PERFECT' ? 100 : 50) * multiplier();
  if (quality === 'PERFECT') perfCnt++; else goodCnt++;
  combo++; if (combo > maxCombo) maxCombo = combo;
  health = Math.min(1, health + CFG.HP_HIT);
  flashJudgment(quality);
  spawnParticles(lane, quality === 'PERFECT' ? 14 : 8);
  bumpCombo();
  updateHUD();
}

function registerMiss() {
  if (state !== 'playing') return;
  missCnt++; combo = 0;
  health = Math.max(0, health - CFG.HP_MISS);
  doMissFlash();
  updateHUD();
  if (health <= 0) {
    state = 'dying';
    dyingTs = performance.now();
    fadeOutAudio(1900);
  }
}

// ─── HUD helpers ──────────────────────────────────────────────────────────────
function updateHUD() {
  $('score-val').textContent = String(score).padStart(7,'0');
  $('combo-val').textContent = `×${combo}`;
  const m = multiplier();
  const multEl = $('mult-val');
  if (multEl) {
    multEl.textContent = `×${m}`;
    multEl.classList.toggle('maxed', m >= 10);
  }
  const fill = $('health-fill');
  fill.style.width = `${health*100}%`;
  fill.style.background =
    health < 0.25 ? 'linear-gradient(90deg,#5c0000,#cc2222)' :
    health < 0.5  ? 'linear-gradient(90deg,#7a5000,#e89000)' :
                    'linear-gradient(90deg,#C8960C,#FFD700)';
}

let _jTimer;
function flashJudgment(text) {
  const el = $('judgment');
  el.textContent = text;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(_jTimer); _jTimer = setTimeout(() => el.classList.remove('show'), 300);
}

let _mTimer;
function doMissFlash() {
  const el = $('miss-vignette');
  el.classList.add('flash');
  clearTimeout(_mTimer); _mTimer = setTimeout(() => el.classList.remove('flash'), 130);
}

let _cTimer;
function bumpCombo() {
  const el = $('combo-val');
  el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  clearTimeout(_cTimer); _cTimer = setTimeout(() => el.classList.remove('bump'), 80);
}

// ─── Particles ────────────────────────────────────────────────────────────────
function spawnParticles(lane, count) {
  const hitY = canvas.height * CFG.HIT_Y_RATIO;
  const cx   = laneX(lane, hitY, hitY);
  const col  = CFG.COLORS[lane];
  for (let i = 0; i < count; i++) {
    const a   = (Math.random() * Math.PI * 2);
    const spd = 80 + Math.random() * 200;
    const isStreak = Math.random() > 0.55;
    particles.push({
      x: cx, y: hitY,
      vx: Math.cos(a) * spd,
      vy: Math.sin(a) * spd - 80,
      life: 1,
      decay: 1.1 + Math.random() * 1.0,
      r: isStreak ? (1 + Math.random() * 1.5) : (2 + Math.random() * 3.5),
      streak: isStreak,
      color: Math.random() > 0.45 ? col.main : col.shine,
    });
  }
  // Central flash burst
  particles.push({
    x: cx, y: hitY,
    vx: 0, vy: 0,
    life: 1, decay: 5,
    r: CFG.LANE_W * 0.38,
    streak: false,
    color: '#FFFFFF',
    flash: true,
  });
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.flash ? p.life * 0.7 : p.life);
    ctx.fillStyle = p.color;
    if (p.streak) {
      const len = Math.sqrt(p.vx * p.vx + p.vy * p.vy) * 0.025 + 2;
      const ax = p.vx / (Math.sqrt(p.vx*p.vx+p.vy*p.vy)||1);
      const ay = p.vy / (Math.sqrt(p.vx*p.vx+p.vy*p.vy)||1);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r, len, Math.atan2(p.vy, p.vx), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render(t) {
  const W = canvas.width, H = canvas.height, hitY = H * CFG.HIT_Y_RATIO;
  ctx.fillStyle = '#050505';
  ctx.fillRect(0,0,W,H);
  drawLanes(W, H, hitY);
  drawHoldTails(t, H, hitY);
  drawNoteHeads(t, H, hitY);
  drawParticles();
  drawKeyGlow(hitY);
}

function yOf(noteTime, t, H) {
  const hitY = H * CFG.HIT_Y_RATIO;
  const dt = noteTime - t;
  if (dt <= 0) return hitY + (-dt / CFG.HWY_SPEED) * hitY;
  if (dt >= CFG.HWY_SPEED) return 0;
  // Hyperbolic perspective-correct mapping: 1/scale changes at constant rate
  const z = dt / CFG.HWY_SPEED;
  const scale = CFG.PERSP_TOP / (CFG.PERSP_TOP + z * (1 - CFG.PERSP_TOP));
  return hitY * (scale - CFG.PERSP_TOP) / (1 - CFG.PERSP_TOP);
}

function drawLanes(W, H, hitY) {
  // ── Highway trapezoid background ──
  const tlX = laneEdgeX(0, 0, hitY), trX = laneEdgeX(4, 0, hitY);
  ctx.beginPath();
  ctx.moveTo(tlX, 0); ctx.lineTo(trX, 0);
  ctx.lineTo(W, hitY); ctx.lineTo(0, hitY);
  ctx.closePath();
  const hwyGrad = ctx.createLinearGradient(0, 0, 0, hitY);
  hwyGrad.addColorStop(0,   '#050505');
  hwyGrad.addColorStop(0.5, '#090909');
  hwyGrad.addColorStop(1,   '#111111');
  ctx.fillStyle = hwyGrad;
  ctx.fill();

  // ── Atmospheric fade at the top (depth fog) ──
  const fogGrad = ctx.createLinearGradient(0, 0, 0, hitY * 0.45);
  fogGrad.addColorStop(0, 'rgba(0,0,0,.62)');
  fogGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fogGrad;
  ctx.beginPath();
  ctx.moveTo(tlX, 0); ctx.lineTo(trX, 0);
  ctx.lineTo(laneEdgeX(4, hitY * 0.45, hitY), hitY * 0.45);
  ctx.lineTo(laneEdgeX(0, hitY * 0.45, hitY), hitY * 0.45);
  ctx.closePath();
  ctx.fill();

  // ── Static depth markers (5 evenly-spaced horizontal lines) ──
  for (let i = 1; i <= 5; i++) {
    const frac = i / 6;
    const y  = frac * hitY;
    const lx = laneEdgeX(0, y, hitY), rx = laneEdgeX(4, y, hitY);
    const alpha = 0.025 + 0.04 * frac;
    ctx.strokeStyle = `rgba(255,215,0,${alpha.toFixed(3)})`;
    ctx.lineWidth = 0.5 + frac * 0.5;
    ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(rx, y); ctx.stroke();
  }

  // ── Alternating lane shading ──
  for (let i = 0; i < CFG.LANE_COUNT; i++) {
    if (i % 2 === 0) {
      ctx.beginPath();
      ctx.moveTo(laneEdgeX(i,   0, hitY), 0);
      ctx.lineTo(laneEdgeX(i+1, 0, hitY), 0);
      ctx.lineTo(laneEdgeX(i+1, hitY, hitY), hitY);
      ctx.lineTo(laneEdgeX(i,   hitY, hitY), hitY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,215,0,.016)';
      ctx.fill();
    }
  }

  // ── Converging lane dividers ──
  for (let i = 1; i < CFG.LANE_COUNT; i++) {
    const topX = laneEdgeX(i, 0, hitY), botX = laneEdgeX(i, hitY, hitY);
    const g = ctx.createLinearGradient(0, 0, 0, hitY);
    g.addColorStop(0,    'rgba(255,215,0,.03)');
    g.addColorStop(0.5,  'rgba(255,215,0,.15)');
    g.addColorStop(1,    'rgba(255,215,0,.10)');
    ctx.strokeStyle = g; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(topX, 0); ctx.lineTo(botX, hitY); ctx.stroke();
  }

  // ── Outer edge rails ──
  for (const edge of [0, 4]) {
    const topX = laneEdgeX(edge, 0, hitY), botX = laneEdgeX(edge, hitY, hitY);
    const eg = ctx.createLinearGradient(0, 0, 0, hitY);
    eg.addColorStop(0,   'rgba(255,215,0,.06)');
    eg.addColorStop(0.6, 'rgba(255,215,0,.28)');
    eg.addColorStop(1,   'rgba(255,215,0,.18)');
    ctx.strokeStyle = eg; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(topX, 0); ctx.lineTo(botX, hitY); ctx.stroke();
  }

  // ── Hit zone glow bar ──
  const hg = ctx.createLinearGradient(0, hitY, W, hitY);
  hg.addColorStop(0,   'rgba(255,215,0,.02)');
  hg.addColorStop(0.5, 'rgba(255,215,0,.90)');
  hg.addColorStop(1,   'rgba(255,215,0,.02)');
  ctx.fillStyle = hg; ctx.fillRect(0, hitY - 1.5, W, 3);

  // ── Neck area below hit zone ──
  const neckGrad = ctx.createLinearGradient(0, hitY, 0, H);
  neckGrad.addColorStop(0, '#111');
  neckGrad.addColorStop(1, '#080808');
  ctx.fillStyle = neckGrad;
  ctx.fillRect(0, hitY, W, H - hitY);

  // ── Hit zone targets (flat ellipses matching disk note shape) ──
  for (let i = 0; i < CFG.LANE_COUNT; i++) {
    const cx = laneX(i, hitY, hitY);
    const rx = CFG.LANE_W * 0.42;
    const ry = rx * 0.27;
    // Ambient glow
    ctx.save();
    ctx.translate(cx, hitY);
    ctx.scale(1, ry / rx);
    const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 1.7);
    rg.addColorStop(0,   'rgba(255,215,0,.10)');
    rg.addColorStop(0.6, 'rgba(255,215,0,.04)');
    rg.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(0, 0, rx * 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Outer ring
    ctx.beginPath();
    ctx.ellipse(cx, hitY, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,215,0,.40)'; ctx.lineWidth = 1.5; ctx.stroke();
    // Inner fill
    ctx.beginPath();
    ctx.ellipse(cx, hitY, rx - 2, Math.max(1, ry - 0.6), 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,215,0,.05)'; ctx.fill();
  }
}

function drawHoldTails(t, H, hitY) {
  for (const n of notes) {
    if (n.type !== 'hold') continue;
    if (n.hit && !n.holdActive) continue;
    if (n.missed && t - n.time > 0.5) continue;

    const col   = CFG.COLORS[n.lane];
    const headY = yOf(n.time, t, H);
    const tailEndY = yOf(n.time + n.duration, t, H);

    let topY, botY;
    if (n.holdActive) {
      topY = Math.max(0, tailEndY);
      botY = hitY;
    } else {
      topY = Math.max(0, tailEndY);
      botY = Math.min(H + 10, headY);
    }
    if (botY - topY < 2) continue;

    const missed = !!n.missed;
    const topHW  = (CFG.TAIL_W / 2) * perspScale(topY, hitY);
    const botHW  = (CFG.TAIL_W / 2) * perspScale(botY, hitY);
    const topCX  = laneX(n.lane, topY, hitY);
    const botCX  = laneX(n.lane, botY, hitY);

    const tg = ctx.createLinearGradient(0, topY, 0, botY);
    if (missed) {
      tg.addColorStop(0, col.main + '22'); tg.addColorStop(1, col.main + '33');
    } else {
      tg.addColorStop(0, col.main + '44'); tg.addColorStop(0.5, col.main + 'aa'); tg.addColorStop(1, col.main + 'cc');
    }
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.moveTo(topCX - topHW, topY);
    ctx.lineTo(topCX + topHW, topY);
    ctx.lineTo(botCX + botHW, botY);
    ctx.lineTo(botCX - botHW, botY);
    ctx.closePath();
    ctx.fill();

    // Center brightness stripe while held
    if (n.holdActive) {
      const sg = ctx.createLinearGradient(0, topY, 0, botY);
      sg.addColorStop(0, col.main + '33'); sg.addColorStop(1, col.main + '88');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.moveTo(topCX - topHW * 0.15, topY);
      ctx.lineTo(topCX + topHW * 0.15, topY);
      ctx.lineTo(botCX + botHW * 0.15, botY);
      ctx.lineTo(botCX - botHW * 0.15, botY);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawNoteHeads(t, H, hitY) {
  for (const n of notes) {
    if (n.hit && !n.holdActive) continue;

    const y = n.holdActive ? hitY : yOf(n.time, t, H);
    if (y < -60 || y > H + 60) continue;
    if (n.missed && t - n.time > 0.35) continue;

    drawHead(n.lane, y, !!n.missed, n.type === 'hold', hitY);
  }
}

function drawHead(lane, y, missed, isHold, hitY) {
  const col   = CFG.COLORS[lane];
  const scale = perspScale(y, hitY);
  const cx    = laneX(lane, y, hitY);
  const rx    = CFG.LANE_W * scale * 0.42;
  const ry    = rx * 0.27;  // flat disk viewed from above horizon
  if (rx < 1.5) return;

  ctx.globalAlpha = missed ? 0.22 : 1;

  // Elliptical glow halo
  if (!missed && scale > 0.20) {
    const glowA = (0.10 + 0.28 * scale).toFixed(2);
    ctx.save();
    ctx.translate(cx, y);
    ctx.scale(1, ry / rx);
    const halo = ctx.createRadialGradient(0, 0, rx * 0.3, 0, 0, rx * 2.4);
    halo.addColorStop(0, isHold ? `rgba(255,160,0,${glowA})` : col.glow.replace('.6', glowA));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, rx * 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Disk body — radial gradient offset toward top for top-lit look
  ctx.save();
  ctx.translate(cx, y);
  ctx.scale(1, ry / rx);
  const sg = ctx.createRadialGradient(-rx * 0.12, -rx * 0.28, rx * 0.02, 0, 0, rx);
  if (isHold) {
    sg.addColorStop(0,   '#FFF8D0');
    sg.addColorStop(0.38,'#FFCC00');
    sg.addColorStop(0.78,'#E08000');
    sg.addColorStop(1,   '#5A3000');
  } else {
    sg.addColorStop(0,   col.shine);
    sg.addColorStop(0.38, col.main);
    sg.addColorStop(1,   col.dark);
  }
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Top rim highlight
  if (!missed && scale > 0.20) {
    ctx.beginPath();
    ctx.ellipse(cx, y, rx, ry, 0, Math.PI + 0.3, Math.PI * 2 - 0.3);
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = Math.max(0.5, rx * 0.07);
    ctx.stroke();
  }

  // Hold note: inner concentric ellipse
  if (isHold && !missed && scale > 0.26) {
    ctx.beginPath();
    ctx.ellipse(cx, y, rx * 0.52, ry * 0.52, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = Math.max(0.5, rx * 0.10);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

function drawKeyGlow(hitY) {
  for (let i = 0; i < CFG.LANE_COUNT; i++) {
    if (!laneHeld[i]) continue;
    const cx = laneX(i, hitY, hitY);
    const r  = CFG.LANE_W * 1.1;
    const isOrange = (i === 1 || i === 3);
    const c1 = isOrange ? 'rgba(255,149,0,.38)'  : 'rgba(255,215,0,.38)';
    const c2 = isOrange ? 'rgba(255,120,0,.14)'  : 'rgba(255,180,0,.14)';
    const cb = isOrange ? 'rgba(255,149,0,.18)'  : 'rgba(255,215,0,.18)';
    const rg = ctx.createRadialGradient(cx, hitY, 0, cx, hitY, r);
    rg.addColorStop(0,    c1);
    rg.addColorStop(0.45, c2);
    rg.addColorStop(1,    'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(cx, hitY, r, 0, Math.PI * 2); ctx.fill();
    // Upward beam
    const beam = ctx.createLinearGradient(cx, hitY, cx, hitY - CFG.LANE_W * 1.8);
    beam.addColorStop(0, cb);
    beam.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = beam;
    const bw = CFG.LANE_W * 0.22;
    ctx.fillRect(cx - bw / 2, hitY - CFG.LANE_W * 1.8, bw, CFG.LANE_W * 1.8);
  }
}

// ─── roundRect polyfill ───────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w/2, h/2);
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r); ctx.closePath();
}

// ─── End game ─────────────────────────────────────────────────────────────────
function endGame(failed) {
  if (state === 'ended' || state === 'idle' || state === 'loading' || state === 'countdown') return;
  state = 'ended';
  stopLoop();
  removeListeners();
  playbackPause();
  // Restore audio volume for next play
  if (audioEl) audioEl.volume = 1;
  else { try { ytPlayer.setVolume(100); } catch {} }

  const acc = totalNotes > 0 ? Math.round((hitCnt / totalNotes) * 100) : 0;
  $('result-headline').textContent = failed ? 'FAITH BROKEN' : 'ASCENDED';
  $('result-song').textContent     = chart?.title || '';
  $('r-score').textContent   = String(score).padStart(7,'0');
  $('r-combo').textContent   = `×${maxCombo}`;
  $('r-acc').textContent     = `${acc}%`;
  $('r-perfect').textContent = `${perfCnt} PERFECT`;
  $('r-good').textContent    = `${goodCnt} GOOD`;
  $('r-miss').textContent    = `${missCnt} MISS`;

  // Fade result screen in
  const rs = $('screen-result');
  rs.style.transition = 'none';
  rs.style.opacity = '0';
  showScreen('screen-result');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    rs.style.transition = 'opacity 0.55s ease';
    rs.style.opacity = '1';
  }));
}
