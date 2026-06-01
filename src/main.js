import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';
import { mulberry32 } from './rng.js';
import { bspSplit } from './splitters/bsp.js';
import {
  startCamera,
  stopCamera,
  processFrame,
  setPreviewCanvas,
  cameraState,
} from './camera.js';
import { makeSpring } from './spring.js';
import { detectSnap } from './sculpt.js';
import { INTERACTIONS, INTERACTION_NAMES } from './interactions.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MODES = ['nikeBars', 'bsp', 'monolith', 'ticker', 'matrix'];
const REF_FS = 100;
const LUT_SAMPLES = 32;
const WDTH_MIN = 100;
const WDTH_MAX = 7500;

const EASINGS = {
  linear: (t) => t,
  sineInOut: (t) => (1 - Math.cos(Math.PI * t)) / 2,
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  quintInOut: (t) =>
    t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2,
  circInOut: (t) =>
    t < 0.5
      ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2
      : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2,
  expoInOut: (t) =>
    t === 0
      ? 0
      : t === 1
      ? 1
      : t < 0.5
      ? Math.pow(2, 20 * t - 10) / 2
      : (2 - Math.pow(2, -20 * t + 10)) / 2,
  expoStrongInOut: (t) =>
    t <= 0
      ? 0
      : t >= 1
      ? 1
      : t < 0.5
      ? Math.pow(2, 40 * t - 20) / 2
      : (2 - Math.pow(2, -40 * t + 20)) / 2,
};

const FONT_AXES = [
  { tag: 'wght', min: 0, max: 1000, default: 700, step: 1 },
  { tag: 'SIZE', min: 1000, max: 4000, default: 1000, step: 1 },
];

const PHASE_PATTERNS = [
  'leftToRight',
  'rightToLeft',
  'centerOut',
  'edgesIn',
  'alternate',
  'random',
];

const state = {
  mode: 'nikeBars',
  seed: 1,
  targetCount: 15,
  text: 'NIKE',
  playing: true,
  period: 4.0,
  easing: 'expoStrongInOut',
  hold: 0.5,
  phasePattern: 'leftToRight',
  phaseUnit: 0.05,
  phaseSeed: 1,
  manualTime: 0.5,
  showBorders: true,
  fitRatio: 1.0,
  cameraEnabled: false,
  mirrorCamera: true,
  interaction: 'sculpt',
  silhouetteBlend: 1.0,
  motionInfluence: 0.7,
  showPreview: true,
  waveFloor: 0.55,
  sculptK0: 0.35,
  sculptK1: 0.65,
  polyAmount: 0.18,
  springStiff: 120,
  springDamp: 14,
  chromaMax: 5,
  accentMix: 1.0,
  snapStrength: 1.0,
};
for (const axis of FONT_AXES) state[axis.tag] = axis.default;

const stage = document.getElementById('stage');

const charLUTs = new Map();
let measureSvg, measureText;

function setupMeasure() {
  measureSvg = document.createElementNS(SVG_NS, 'svg');
  measureSvg.setAttribute('width', '0');
  measureSvg.setAttribute('height', '0');
  Object.assign(measureSvg.style, {
    position: 'absolute',
    left: '-9999px',
    top: '0',
    overflow: 'visible',
    pointerEvents: 'none',
  });
  measureText = document.createElementNS(SVG_NS, 'text');
  measureText.setAttribute('font-size', String(REF_FS));
  measureText.setAttribute('dominant-baseline', 'alphabetic');
  measureSvg.appendChild(measureText);
  stage.appendChild(measureSvg);
}

function setMeasureAxes(wdth) {
  measureText.style.fontVariationSettings = `"wght" ${state.wght}, "wdth" ${wdth}, "SIZE" ${state.SIZE}`;
}

function buildLUT(char) {
  const lut = [];
  for (let i = 0; i < LUT_SAMPLES; i++) {
    const t = i / (LUT_SAMPLES - 1);
    const wdth = WDTH_MIN + (WDTH_MAX - WDTH_MIN) * t;
    setMeasureAxes(wdth);
    measureText.textContent = char;
    let bbox;
    try {
      bbox = measureText.getBBox();
    } catch {
      return null;
    }
    if (!bbox || bbox.width === 0 || bbox.height === 0) return null;
    lut.push({
      wdth,
      bboxW: bbox.width,
      bboxH: bbox.height,
      bboxX: bbox.x,
      bboxY: bbox.y,
    });
  }
  return lut;
}

function getLUT(char) {
  if (charLUTs.has(char)) return charLUTs.get(char);
  const lut = buildLUT(char);
  if (!lut) return null;
  charLUTs.set(char, lut);
  return lut;
}

function invalidateLUTs() {
  charLUTs.clear();
}

function lerpEntry(a, b, u) {
  return {
    wdth: a.wdth + u * (b.wdth - a.wdth),
    bboxW: a.bboxW + u * (b.bboxW - a.bboxW),
    bboxH: a.bboxH + u * (b.bboxH - a.bboxH),
    bboxX: a.bboxX + u * (b.bboxX - a.bboxX),
    bboxY: a.bboxY + u * (b.bboxY - a.bboxY),
  };
}

function findSampleForRatio(lut, targetRatio) {
  const first = lut[0];
  const last = lut[lut.length - 1];
  const minR = first.bboxW / first.bboxH;
  const maxR = last.bboxW / last.bboxH;
  if (!isFinite(targetRatio) || targetRatio >= maxR) return last;
  if (targetRatio <= minR) return first;
  for (let i = 0; i < lut.length - 1; i++) {
    const r0 = lut[i].bboxW / lut[i].bboxH;
    const r1 = lut[i + 1].bboxW / lut[i + 1].bboxH;
    if (r0 <= targetRatio && targetRatio <= r1) {
      const u = r1 === r0 ? 0 : (targetRatio - r0) / (r1 - r0);
      return lerpEntry(lut[i], lut[i + 1], u);
    }
  }
  return last;
}

let cells = [];

function makeCell(ch) {
  const el = document.createElement('div');
  el.className = 'cell' + (state.showBorders ? ' bordered' : '');
  const svg = document.createElementNS(SVG_NS, 'svg');
  const ghostL = document.createElementNS(SVG_NS, 'text');
  ghostL.setAttribute('class', 'ghost-l');
  ghostL.setAttribute('text-anchor', 'middle');
  ghostL.setAttribute('dominant-baseline', 'alphabetic');
  ghostL.textContent = ch;
  const ghostR = document.createElementNS(SVG_NS, 'text');
  ghostR.setAttribute('class', 'ghost-r');
  ghostR.setAttribute('text-anchor', 'middle');
  ghostR.setAttribute('dominant-baseline', 'alphabetic');
  ghostR.textContent = ch;
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('class', 'master');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'alphabetic');
  text.textContent = ch;
  svg.appendChild(ghostL);
  svg.appendChild(ghostR);
  svg.appendChild(text);
  el.appendChild(svg);
  return { el, svg, text, ghostL, ghostR, char: ch };
}

function clearCells() {
  for (const c of cells) c.el.remove();
  cells = [];
}

function positionCell(c, x, y) {
  c.el.style.left = x + 'px';
  c.el.style.top = y + 'px';
}

function fitCell(c, natW, natH, actW = natW, actH = natH, wghtOverride = null) {
  c.el.style.width = actW + 'px';
  c.el.style.height = actH + 'px';
  c.svg.setAttribute('width', actW);
  c.svg.setAttribute('height', actH);
  c.svg.setAttribute('viewBox', `0 0 ${Math.max(natW, 1)} ${Math.max(natH, 1)}`);
  c.svg.setAttribute('preserveAspectRatio', 'none');

  if (natW <= 0 || natH <= 0) {
    c.text.setAttribute('font-size', '0');
    if (c.ghostL) c.ghostL.setAttribute('font-size', '0');
    if (c.ghostR) c.ghostR.setAttribute('font-size', '0');
    return;
  }

  const lut = getLUT(c.char);
  if (!lut) return;

  const targetRatio = natW / natH;
  const sample = findSampleForRatio(lut, targetRatio);

  const fsByH = (REF_FS * natH) / sample.bboxH;
  const fsByW = (REF_FS * natW) / sample.bboxW;
  const fontSize = Math.min(fsByH, fsByW) * state.fitRatio;
  const scale = fontSize / REF_FS;

  const cx = natW / 2;
  const cy = natH / 2 - (sample.bboxY + sample.bboxH / 2) * scale;
  const wght = wghtOverride == null ? state.wght : wghtOverride;
  const variation = `"wght" ${wght}, "wdth" ${sample.wdth}, "SIZE" ${state.SIZE}`;
  const cab = chromaPx;

  c.text.setAttribute('font-size', fontSize);
  c.text.setAttribute('x', cx);
  c.text.setAttribute('y', cy);
  c.text.style.fontVariationSettings = variation;

  if (c.ghostL) {
    c.ghostL.setAttribute('font-size', fontSize);
    c.ghostL.setAttribute('x', cx - cab);
    c.ghostL.setAttribute('y', cy);
    c.ghostL.style.fontVariationSettings = variation;
  }
  if (c.ghostR) {
    c.ghostR.setAttribute('font-size', fontSize);
    c.ghostR.setAttribute('x', cx + cab);
    c.ghostR.setAttribute('y', cy);
    c.ghostR.style.fontVariationSettings = variation;
  }
}

function buildBSP() {
  clearCells();
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const rects = bspSplit(w, h, state.seed, { targetCount: state.targetCount });
  const letterRng = mulberry32((state.seed ^ 0x9e3779b9) >>> 0);
  for (const r of rects) {
    const ch = ALPHABET[Math.floor(letterRng() * ALPHABET.length)];
    const c = makeCell(ch);
    c.rect = r;
    cells.push(c);
    stage.appendChild(c.el);
    positionCell(c, r.x, r.y);
    fitCell(c, r.w, r.h);
  }
}

function refitBSP() {
  for (const c of cells) {
    if (c.rect) fitCell(c, c.rect.w, c.rect.h);
  }
}

function buildNike() {
  clearCells();
  const cols = state.text.length;
  rebuildPerCol(cols);
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < cols; i++) {
      const c = makeCell(state.text[i]);
      c.col = i;
      c.row = row;
      cells.push(c);
      stage.appendChild(c.el);
    }
  }
  updateNikeLayout();
}

function updateNikeLayout() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const cols = state.text.length || 1;
  const colW = w / cols;

  if (phaseAccums.length !== cols) rebuildPerCol(cols);

  const camActive = state.cameraEnabled && cameraState.ready;
  const motionRaw = camActive ? cameraState.motion : 0;
  const motionS = motionSpring.value;
  const presenceS = presenceSpring.value;
  const motionT = motionRaw * state.motionInfluence;
  const periodAdj = state.period * (1 - motionT * 0.75);
  const holdAdj = state.hold * (1 - motionT);
  const holdFrac = Math.min(0.49, Math.max(0, holdAdj / Math.max(periodAdj, 0.01)));

  // synthetic wave + per-column body data
  const synth = new Array(cols);
  const silTop = new Array(cols);
  const silBottom = new Array(cols);
  const coverage = new Array(cols);
  const colMotion = new Array(cols);
  const camHasBody = new Array(cols);
  const haveCols = camActive && cameraState.colTop.length === cols;
  for (let i = 0; i < cols; i++) {
    const offsetFrac = getColPhaseOffset(i, cols);
    const localPhase = state.playing ? phaseAccums[i] : state.manualTime;
    const phase = (((localPhase - offsetFrac) % 1) + 1) % 1;
    synth[i] = easedDividerByPhase(phase, state.easing, holdFrac);

    const has = haveCols && cameraState.colTop[i] >= 0;
    camHasBody[i] = has;
    silTop[i] = has ? silSprings[i].value : -1;
    silBottom[i] = has ? cameraState.colBottom[i] : -1;
    coverage[i] = camActive ? covSmooth[i] || 0 : 0;
    colMotion[i] = haveCols ? cameraState.colMotion[i] || 0 : 0;
  }

  const ctx = {
    cols,
    w,
    h,
    colW,
    t: nowSeconds,
    presence: presenceS,
    motion: motionS,
    blend: state.silhouetteBlend,
    camActive,
    synth,
    silTop,
    silBottom,
    coverage,
    colMotion,
    centroidX: camActive ? cameraState.centroidX : -1,
    centroidY: camActive ? cameraState.centroidY : -1,
    state,
    EASINGS,
  };

  const interaction = INTERACTIONS[state.interaction] || INTERACTIONS.sculpt;
  const field = interaction.compute(ctx);

  const colTopH = new Array(cols);
  for (let i = 0; i < cols; i++) {
    const d = clamp01(field.divider[i]);
    if (state.snapStrength > 0 && detectSnap(prevDivs[i], d)) {
      snapPulses[i] = state.snapStrength;
    }
    prevDivs[i] = d;
    colTopH[i] = Math.round(h * d);
  }

  for (const c of cells) {
    const col = c.col;
    const isTop = c.row === 0;
    const topH = colTopH[col];
    const botH = h - topH;
    const x = col * colW;
    const y = isTop ? 0 : topH;
    const rh = isTop ? topH : botH;
    const wght = isTop ? field.topWght[col] : field.botWght[col];
    positionCell(c, x, y);
    fitCell(c, colW, h, colW, rh, wght);
    const tint = isTop ? field.topTint[col] : field.botTint[col];
    c.el.style.setProperty('--cell-vibe', clamp01(tint).toFixed(3));
    const dx = isTop ? field.topDx[col] : field.botDx[col];
    const dy = isTop ? field.topDy[col] : field.botDy[col];
    c.el.style.transform = dx || dy ? `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` : '';
    const op = isTop ? field.topOpacity[col] : field.botOpacity[col];
    c.el.style.opacity = op >= 1 ? '' : clamp01(op).toFixed(3);
  }

  updateTrail(interaction, camActive, cols, colW, h, colTopH);

  if (silhouetteContour && silhouetteContourPath) {
    silhouetteContour.setAttribute('viewBox', `0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`);
    silhouetteContour.setAttribute('width', w);
    silhouetteContour.setAttribute('height', h);
    let path = '';
    let drawing = false;
    if (camActive && !interaction.usesTrail) {
      for (let i = 0; i < cols; i++) {
        if (camHasBody[i]) {
          const cx = (i + 0.5) * colW;
          const cy = silSprings[i].value * h;
          path += (drawing ? ' L ' : 'M ') + cx.toFixed(1) + ' ' + cy.toFixed(1);
          drawing = true;
        } else {
          drawing = false;
        }
      }
    }
    silhouetteContourPath.setAttribute('d', path);
    silhouetteContourPath.setAttribute('stroke-width', String(3 + 10 * motionS));
    const baseOpacity = camActive ? presenceS * state.silhouetteBlend : 0;
    silhouetteContour.style.opacity = baseOpacity.toFixed(3);
  }

  for (let i = 0; i < cols; i++) {
    const bar = snapBars[i];
    if (!bar) continue;
    const pulse = snapPulses[i];
    snapPulses[i] = pulse * 0.86;
    if (pulse < 0.02) {
      bar.style.opacity = '0';
      continue;
    }
    const dividerY = colTopH[i];
    const barH = 2 + 8 * pulse;
    bar.style.opacity = String(0.6 + 0.4 * pulse);
    bar.style.transform = `translate(${i * colW}px, ${dividerY - barH / 2}px)`;
    bar.style.width = colW + 'px';
    bar.style.height = barH + 'px';
  }
}

let phaseAccums = [];
let periodMuls = [];
let silSprings = [];
let prevDivs = [];
let snapPulses = [];
let covSmooth = [];
const presenceSpring = makeSpring(60, 12, 0);
const motionSpring = makeSpring(40, 10, 0);
let chromaPx = 0;
let nowSeconds = 0;
let lastFrame = 0;
let snapBars = [];
let snapOverlay = null;
let silhouetteContour = null;
let silhouetteContourPath = null;
let trailCanvas = null;
let trailCtx = null;
let trailHistory = [];
const TRAIL_LEN = 26;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

function updateTrail(interaction, camActive, cols, colW, h, colTopH) {
  if (!trailCanvas || !trailCtx) return;
  if (!interaction.usesTrail || !camActive) {
    if (trailHistory.length) {
      trailHistory = [];
      trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    }
    return;
  }
  if (
    trailCanvas.width !== Math.round(stage.clientWidth) ||
    trailCanvas.height !== Math.round(stage.clientHeight)
  ) {
    trailCanvas.width = Math.round(stage.clientWidth);
    trailCanvas.height = Math.round(stage.clientHeight);
  }

  trailHistory.push(colTopH.slice(0, cols));
  if (trailHistory.length > TRAIL_LEN) trailHistory.shift();

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff3b1f';
  trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
  trailCtx.strokeStyle = accent;
  trailCtx.lineCap = 'round';
  trailCtx.lineJoin = 'round';
  const n = trailHistory.length;
  for (let k = 0; k < n; k++) {
    const seam = trailHistory[k];
    const age = (k + 1) / n; // newest -> 1
    trailCtx.globalAlpha = age * age * 0.55;
    trailCtx.lineWidth = (1 + 6 * motionSpring.value) * age;
    trailCtx.beginPath();
    for (let i = 0; i < seam.length; i++) {
      const x = (i + 0.5) * colW;
      const y = seam[i];
      if (i === 0) trailCtx.moveTo(x, y);
      else trailCtx.lineTo(x, y);
    }
    trailCtx.stroke();
  }
  trailCtx.globalAlpha = 1;
}

function rebuildPerCol(cols) {
  if (phaseAccums.length !== cols) {
    phaseAccums = new Array(cols).fill(0).map((_, i) => 0.25 + i * 0.001);
  }
  buildPeriodMuls(cols);
  silSprings = new Array(cols).fill(0).map(() => makeSpring(state.springStiff, state.springDamp, 0.5));
  prevDivs = new Array(cols).fill(0.5);
  snapPulses = new Array(cols).fill(0);
  covSmooth = new Array(cols).fill(0);
  buildSnapBars(cols);
}

function buildPeriodMuls(cols) {
  periodMuls = new Array(cols);
  const rng = mulberry32(((state.phaseSeed * 7919 + 1) >>> 0) || 1);
  for (let i = 0; i < cols; i++) {
    periodMuls[i] = 1 + (rng() - 0.5) * state.polyAmount;
  }
}

function buildSnapBars(cols) {
  if (!snapOverlay) return;
  snapOverlay.innerHTML = '';
  snapBars = [];
  for (let i = 0; i < cols; i++) {
    const bar = document.createElement('div');
    bar.className = 'snap-bar';
    snapOverlay.appendChild(bar);
    snapBars.push(bar);
  }
}

function tick(now) {
  requestAnimationFrame(tick);
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  nowSeconds = now / 1000;

  if (state.cameraEnabled && cameraState.ready) {
    processFrame(state.text.length || 1, state.mirrorCamera);
  }

  const camActive = state.cameraEnabled && cameraState.ready;
  presenceSpring.step(dt, camActive ? cameraState.presence : 0);
  motionSpring.step(dt, camActive ? cameraState.motion : 0);

  const vibe = Math.min(1, presenceSpring.value * 0.6 + motionSpring.value * 0.7);
  chromaPx = state.chromaMax * (0.05 + 0.95 * motionSpring.value);
  document.documentElement.style.setProperty('--vibe', vibe.toFixed(3));
  document.documentElement.style.setProperty('--accent-mix', (state.accentMix * vibe).toFixed(3));

  if (state.mode === 'nikeBars') {
    const cols = state.text.length || 1;
    if (phaseAccums.length !== cols) rebuildPerCol(cols);

    if (camActive) {
      const haveCols = cameraState.colTop.length === cols;
      for (let i = 0; i < cols; i++) {
        const raw = cameraState.silhouetteDivs[i];
        if (raw >= 0) silSprings[i].step(dt, raw);
        const cov = haveCols ? cameraState.colCoverage[i] || 0 : 0;
        covSmooth[i] = (covSmooth[i] || 0) * 0.8 + cov * 0.2;
      }
    } else {
      for (let i = 0; i < cols; i++) covSmooth[i] = (covSmooth[i] || 0) * 0.9;
    }

    if (state.playing) {
      const motionT = (camActive ? cameraState.motion : 0) * state.motionInfluence;
      const periodAdj = state.period * (1 - motionT * 0.75);
      const periodSafe = Math.max(periodAdj, 0.01);
      for (let i = 0; i < cols; i++) {
        const mul = periodMuls[i] || 1;
        phaseAccums[i] = (phaseAccums[i] + dt / (periodSafe * mul)) % 1;
      }
    }

    updateNikeLayout();
  } else if (state.mode === 'monolith') {
    updateMonolith(dt);
  } else if (state.mode === 'ticker') {
    updateTicker(dt);
  } else if (state.mode === 'matrix') {
    updateMatrix(dt);
  }
}

function getColPhaseOffset(col, totalCols) {
  if (state.phaseUnit <= 0 || totalCols <= 1) return 0;
  const u = state.phaseUnit;
  const c = (totalCols - 1) / 2;
  switch (state.phasePattern) {
    case 'leftToRight':
      return col * u;
    case 'rightToLeft':
      return (totalCols - 1 - col) * u;
    case 'centerOut':
      return Math.abs(col - c) * u;
    case 'edgesIn':
      return (c - Math.abs(col - c)) * u;
    case 'alternate':
      return (col % 2) * u;
    case 'random': {
      const rng = mulberry32(((state.phaseSeed * 31 + col * 0x9e3779b9) >>> 0) || 1);
      return rng() * (totalCols - 1) * u;
    }
    default:
      return 0;
  }
}

function easedDividerByPhase(phase, easingName, holdFrac) {
  const riseFrac = 0.5 - holdFrac;
  let progress;
  if (riseFrac <= 0) {
    progress = phase < 0.5 ? 0 : 1;
  } else if (phase < holdFrac) {
    progress = 0;
  } else if (phase < holdFrac + riseFrac) {
    progress = (phase - holdFrac) / riseFrac;
  } else if (phase < 2 * holdFrac + riseFrac) {
    progress = 1;
  } else {
    progress = 1 - (phase - 2 * holdFrac - riseFrac) / riseFrac;
  }
  const fn = EASINGS[easingName] || EASINGS.sineInOut;
  return fn(progress);
}

function applyFontVariation() {
  invalidateLUTs();
  refitAll();
}

function rebuild() {
  if (trailHistory.length && trailCtx) {
    trailHistory = [];
    trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
  }
  teardownExtraModes();
  if (state.mode === 'bsp') buildBSP();
  else if (state.mode === 'monolith') buildMonolith();
  else if (state.mode === 'ticker') buildTicker();
  else if (state.mode === 'matrix') buildMatrix();
  else buildNike();
}

function refitAll() {
  if (state.mode === 'bsp') refitBSP();
  else if (state.mode === 'monolith') fitMonolith();
  else if (state.mode === 'ticker') fitTicker();
  else if (state.mode === 'matrix') fitMatrix();
  else updateNikeLayout();
}

function teardownExtraModes() {
  if (monolithCell) {
    monolithCell.el.remove();
    monolithCell = null;
  }
  for (const row of tickerRows) row.el.remove();
  tickerRows = [];
  for (const col of matrixCols) col.el.remove();
  matrixCols = [];
}

function applyBorders() {
  for (const c of cells) c.el.classList.toggle('bordered', state.showBorders);
}

// ===== monolith =====
// One huge NIKE filling the screen. Camera modulates wght / wdth / position.
let monolithCell = null;

function buildMonolith() {
  clearCells();
  const el = document.createElement('div');
  el.className = 'mode-monolith';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'alphabetic');
  text.setAttribute('class', 'monolith-text');
  text.textContent = 'NIKE';
  svg.appendChild(text);
  el.appendChild(svg);
  stage.appendChild(el);
  monolithCell = { el, svg, text };
  fitMonolith();
}

function fitMonolith() {
  if (!monolithCell) return;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const c = monolithCell;
  c.el.style.position = 'absolute';
  c.el.style.left = '0';
  c.el.style.top = '0';
  c.el.style.width = w + 'px';
  c.el.style.height = h + 'px';
  c.el.style.overflow = 'hidden';
  c.svg.setAttribute('width', w);
  c.svg.setAttribute('height', h);
  c.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
}

function updateMonolith(dt) {
  if (!monolithCell) return;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (w !== monolithCell.lastW || h !== monolithCell.lastH) {
    fitMonolith();
    monolithCell.lastW = w;
    monolithCell.lastH = h;
  }
  const camActive = state.cameraEnabled && cameraState.ready;
  const p = presenceSpring.value;
  const m = motionSpring.value;
  const baseWght = camActive ? lerp(state.wght, 1000, p) : state.wght;
  const baseWdth = 1000;
  const wdthMod = camActive ? lerp(baseWdth, 7500, Math.min(1, m * 1.6)) : baseWdth;
  const variation = `"wght" ${baseWght.toFixed(0)}, "wdth" ${wdthMod.toFixed(0)}, "SIZE" ${state.SIZE}`;
  const text = monolithCell.text;
  text.style.fontVariationSettings = variation;
  // First pass: set font-size 100 to measure
  text.setAttribute('font-size', '100');
  let bbox;
  try {
    bbox = text.getBBox();
  } catch {
    return;
  }
  if (!bbox || bbox.width === 0 || bbox.height === 0) return;
  const fs = Math.min(w / bbox.width, h / bbox.height) * 100 * state.fitRatio;
  text.setAttribute('font-size', fs);
  const scale = fs / 100;
  const cx = w / 2;
  const cy = h / 2 - (bbox.y + bbox.height / 2) * scale;
  // centroid-driven horizontal shift (up to 8% width)
  const shiftX = camActive && cameraState.centroidX >= 0
    ? (cameraState.centroidX - 0.5) * w * 0.08 * p
    : 0;
  const shiftY = camActive && cameraState.centroidY >= 0
    ? (cameraState.centroidY - 0.5) * h * 0.04 * p
    : 0;
  text.setAttribute('x', cx + shiftX);
  text.setAttribute('y', cy + shiftY);
}

// ===== ticker =====
// Multiple horizontal stripes of "NIKE NIKE..." scrolling.
let tickerRows = [];
const TICKER_ROWS = 6;
const TICKER_TEXT = ' NIKE'.repeat(30);

function buildTicker() {
  clearCells();
  tickerRows = [];
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const rowH = h / TICKER_ROWS;
  for (let i = 0; i < TICKER_ROWS; i++) {
    const row = makeTickerRow(i, w, rowH);
    row.el.style.top = (i * rowH) + 'px';
    stage.appendChild(row.el);
    tickerRows.push(row);
  }
}

function makeTickerRow(idx, w, rowH) {
  const el = document.createElement('div');
  el.className = 'ticker-row';
  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.width = '100%';
  el.style.height = rowH + 'px';
  el.style.overflow = 'hidden';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', rowH);
  svg.setAttribute('viewBox', `0 0 ${w} ${rowH}`);

  const group = document.createElementNS(SVG_NS, 'g');
  const text1 = document.createElementNS(SVG_NS, 'text');
  text1.setAttribute('y', rowH * 0.78);
  text1.setAttribute('x', 0);
  text1.setAttribute('dominant-baseline', 'alphabetic');
  text1.textContent = TICKER_TEXT;
  const text2 = document.createElementNS(SVG_NS, 'text');
  text2.setAttribute('y', rowH * 0.78);
  text2.setAttribute('dominant-baseline', 'alphabetic');
  text2.textContent = TICKER_TEXT;

  group.appendChild(text1);
  group.appendChild(text2);
  svg.appendChild(group);
  el.appendChild(svg);

  const wghts = [180, 320, 540, 760, 920, 420];
  const wght = wghts[idx % wghts.length];
  const speeds = [-220, 140, -90, 260, -180, 110];
  const speed = speeds[idx % speeds.length];
  const variation = `"wght" ${wght}, "wdth" 600, "SIZE" 1000`;
  text1.style.fontVariationSettings = variation;
  text2.style.fontVariationSettings = variation;
  text1.setAttribute('font-size', rowH * 0.9);
  text2.setAttribute('font-size', rowH * 0.9);
  text1.style.fill = 'var(--fg)';
  text2.style.fill = 'var(--fg)';

  return { el, svg, group, text1, text2, speed, wght, idx, rowH, offset: 0, textW: 0, lastW: w };
}

function fitTicker() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!tickerRows.length || tickerRows[0].rowH !== h / TICKER_ROWS) {
    buildTicker();
    return;
  }
  for (const row of tickerRows) {
    row.svg.setAttribute('width', w);
    row.svg.setAttribute('viewBox', `0 0 ${w} ${row.rowH}`);
    row.lastW = w;
    row.textW = 0; // force re-measure
  }
}

function updateTicker(dt) {
  if (!tickerRows.length) return;
  const w = stage.clientWidth;
  if (w !== tickerRows[0].lastW) fitTicker();
  const camActive = state.cameraEnabled && cameraState.ready;
  const m = motionSpring.value;
  const p = presenceSpring.value;
  const accel = 1 + m * 3;
  for (const row of tickerRows) {
    if (!row.textW) {
      try {
        row.textW = row.text1.getBBox().width;
      } catch {
        row.textW = 0;
      }
      if (!row.textW) continue;
      row.text2.setAttribute('x', row.textW);
    }
    row.offset = (row.offset + row.speed * accel * dt) % row.textW;
    if (row.offset < 0) row.offset += row.textW;
    row.group.setAttribute('transform', `translate(${-row.offset}, 0)`);
    // body-driven row tint: rows close to centroidY light up
    let rowTint = 0;
    if (camActive && cameraState.centroidY >= 0) {
      const rowMid = (row.idx + 0.5) / TICKER_ROWS;
      const dist = Math.abs(rowMid - cameraState.centroidY);
      rowTint = Math.max(0, 1 - dist * 3.5) * p;
    }
    const fill = rowTint > 0.02
      ? `color-mix(in oklab, var(--fg), var(--accent) ${(rowTint * 90).toFixed(1)}%)`
      : 'var(--fg)';
    row.text1.style.fill = fill;
    row.text2.style.fill = fill;
  }
}

// ===== matrix =====
// Vertical streams of NIKE letters per column.
let matrixCols = [];
const MATRIX_COLS = 12;

function buildMatrix() {
  clearCells();
  matrixCols = [];
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const colW = w / MATRIX_COLS;
  for (let i = 0; i < MATRIX_COLS; i++) {
    const col = makeMatrixCol(i, colW, h);
    col.el.style.left = (i * colW) + 'px';
    stage.appendChild(col.el);
    matrixCols.push(col);
  }
}

function makeMatrixCol(idx, colW, h) {
  const el = document.createElement('div');
  el.className = 'matrix-col';
  el.style.position = 'absolute';
  el.style.top = '0';
  el.style.width = colW + 'px';
  el.style.height = h + 'px';
  el.style.overflow = 'hidden';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', colW);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${colW} ${h}`);

  const group = document.createElementNS(SVG_NS, 'g');
  const lineH = colW * 1.15;
  const chars = Math.ceil(h / lineH) + 4;
  const fontSize = lineH * 0.95;
  for (let k = 0; k < chars * 2; k++) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('x', colW / 2);
    t.setAttribute('y', k * lineH);
    t.setAttribute('font-size', fontSize);
    t.textContent = 'NIKE'[k % 4];
    t.style.fontVariationSettings = '"wght" 540, "wdth" 600, "SIZE" 1000';
    group.appendChild(t);
  }
  svg.appendChild(group);
  el.appendChild(svg);

  const baseSpeeds = [110, 70, 160, 95, 200, 130, 85, 145, 175, 100, 230, 60];
  const baseSpeed = baseSpeeds[idx % baseSpeeds.length];
  return { el, svg, group, chars, lineH, fontSize, colW, h, idx, offset: 0, baseSpeed };
}

function fitMatrix() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (matrixCols.length !== MATRIX_COLS || matrixCols[0].h !== h) {
    buildMatrix();
    return;
  }
  const colW = w / MATRIX_COLS;
  for (let i = 0; i < matrixCols.length; i++) {
    const col = matrixCols[i];
    col.el.style.left = (i * colW) + 'px';
    col.el.style.width = colW + 'px';
    col.svg.setAttribute('width', colW);
    col.svg.setAttribute('viewBox', `0 0 ${colW} ${h}`);
    col.colW = colW;
  }
}

function updateMatrix(dt) {
  if (!matrixCols.length) return;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (w / MATRIX_COLS !== matrixCols[0].colW) fitMatrix();
  const camActive = state.cameraEnabled && cameraState.ready;
  const haveCols = camActive && cameraState.colTop.length === MATRIX_COLS;
  for (let i = 0; i < matrixCols.length; i++) {
    const col = matrixCols[i];
    // body slowing factor per column (1 = unchanged, 0 = stopped)
    let bodyHere = 0;
    if (haveCols) {
      const top = cameraState.colTop[i];
      if (top >= 0) bodyHere = presenceSpring.value;
    }
    const slow = 1 - bodyHere * 0.85;
    const speed = col.baseSpeed * slow;
    col.offset = (col.offset + speed * dt) % col.lineH;
    col.group.setAttribute('transform', `translate(0, ${col.offset})`);
    // weight + color shift on bodied columns
    const wght = lerp(540, 1000, bodyHere);
    const variation = `"wght" ${wght.toFixed(0)}, "wdth" 600, "SIZE" 1000`;
    const fill = bodyHere > 0.02
      ? `color-mix(in oklab, var(--fg), var(--accent) ${(bodyHere * 90).toFixed(1)}%)`
      : 'var(--fg)';
    // Only update children when bodyHere meaningfully changes (cheap heuristic)
    const lastFill = col.lastFill;
    const lastWght = col.lastWght;
    if (Math.abs((lastWght || 0) - wght) > 6 || lastFill !== fill) {
      const children = col.group.children;
      for (let k = 0; k < children.length; k++) {
        children[k].style.fontVariationSettings = variation;
        children[k].style.fill = fill;
      }
      col.lastWght = wght;
      col.lastFill = fill;
    }
  }
}

function buildGUI() {
  const gui = new GUI({ title: 'Controls' });

  const common = gui.addFolder('Mode');
  common.add(state, 'mode', MODES).onChange(rebuild);
  common.add(state, 'showBorders').name('borders').onChange(applyBorders);
  common.add(state, 'fitRatio', 0.5, 1.0, 0.01).name('fit ratio').onChange(refitAll);

  const nike = gui.addFolder('NIKE bars');
  const textCtrl = nike.add(state, 'text').name('text');
  textCtrl.onFinishChange((v) => {
    let normalized = String(v || '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 12);
    if (!normalized) normalized = 'NIKE';
    state.text = normalized;
    textCtrl.updateDisplay();
    if (state.mode === 'nikeBars') rebuild();
  });
  nike.add(state, 'playing').name('play');
  nike.add(state, 'period', 0.5, 10, 0.1).name('period (s)');
  nike.add(state, 'easing', Object.keys(EASINGS)).name('easing');
  nike.add(state, 'hold', 0, 3, 0.05).name('hold (s)');
  nike.add(state, 'phasePattern', PHASE_PATTERNS).name('phase pattern');
  nike.add(state, 'phaseUnit', 0, 0.5, 0.005).name('phase unit');
  nike.add(state, 'phaseSeed', 0, 9999, 1).name('phase seed');
  nike.add(state, 'manualTime', 0, 1, 0.001).name('manual time');

  const bsp = gui.addFolder('BSP');
  bsp.close();
  const seedCtrl = bsp.add(state, 'seed', 0, 99999, 1).onChange(() => {
    if (state.mode === 'bsp') rebuild();
  });
  bsp.add(state, 'targetCount', 2, 40, 1).name('target count').onChange(() => {
    if (state.mode === 'bsp') rebuild();
  });
  bsp
    .add(
      {
        randomize: () => {
          state.seed = Math.floor(Math.random() * 100000);
          seedCtrl.updateDisplay();
          if (state.mode === 'bsp') rebuild();
        },
      },
      'randomize'
    )
    .name('random seed');

  const cam = gui.addFolder('Camera');
  const camCtrl = cam.add(state, 'cameraEnabled').name('enable');
  camCtrl.onChange(async (v) => {
    if (v) {
      const ok = await startCamera();
      if (!ok) {
        state.cameraEnabled = false;
        camCtrl.updateDisplay();
      }
    } else {
      stopCamera();
    }
  });
  cam.add(state, 'mirrorCamera').name('mirror');
  cam.add(state, 'interaction', INTERACTION_NAMES).name('interaction');
  cam.add(state, 'silhouetteBlend', 0, 1, 0.01).name('silhouette blend');
  cam.add(state, 'motionInfluence', 0, 1, 0.01).name('motion influence');
  cam.add(state, 'showPreview').name('show preview').onChange((v) => {
    if (previewEl) previewEl.hidden = !v;
  });

  const sculpt = gui.addFolder('Sculpt');
  sculpt.add(state, 'waveFloor', 0.2, 1.0, 0.01).name('wave floor');
  sculpt.add(state, 'sculptK0', 0, 1, 0.01).name('sculpt @presence');
  sculpt.add(state, 'sculptK1', 0, 1, 0.01).name('sculpt @motion');
  sculpt.add(state, 'polyAmount', 0, 0.4, 0.005).name('polyrhythm').onChange(() => {
    if (state.mode === 'nikeBars') buildPeriodMuls(state.text.length || 1);
  });
  sculpt.add(state, 'springStiff', 20, 300, 1).name('spring stiff').onChange(() => {
    rebuildPerCol(state.text.length || 1);
  });
  sculpt.add(state, 'springDamp', 4, 40, 0.5).name('spring damp').onChange(() => {
    rebuildPerCol(state.text.length || 1);
  });
  sculpt.add(state, 'chromaMax', 0, 12, 0.1).name('chroma max (px)');
  sculpt.add(state, 'accentMix', 0, 1, 0.01).name('accent mix');
  sculpt.add(state, 'snapStrength', 0, 2, 0.01).name('snap');

  const axes = gui.addFolder('Font axes');
  for (const axis of FONT_AXES) {
    axes.add(state, axis.tag, axis.min, axis.max, axis.step).onChange(applyFontVariation);
  }
  axes
    .add(
      {
        reset: () => {
          for (const axis of FONT_AXES) state[axis.tag] = axis.default;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          applyFontVariation();
        },
      },
      'reset'
    )
    .name('reset axes');
}

const previewEl = document.createElement('div');
previewEl.id = 'camera-preview';
previewEl.hidden = !state.showPreview;
const previewCanvas = document.createElement('canvas');
previewCanvas.width = 240;
previewCanvas.height = 180;
previewEl.appendChild(previewCanvas);
document.body.appendChild(previewEl);
setPreviewCanvas(previewCanvas);

trailCanvas = document.createElement('canvas');
trailCanvas.id = 'trail-canvas';
trailCanvas.width = Math.round(stage.clientWidth) || 1280;
trailCanvas.height = Math.round(stage.clientHeight) || 720;
trailCtx = trailCanvas.getContext('2d');
stage.appendChild(trailCanvas);

snapOverlay = document.createElement('div');
snapOverlay.id = 'snap-overlay';
stage.appendChild(snapOverlay);

silhouetteContour = document.createElementNS(SVG_NS, 'svg');
silhouetteContour.id = 'silhouette-contour';
silhouetteContour.setAttribute('preserveAspectRatio', 'none');
silhouetteContourPath = document.createElementNS(SVG_NS, 'path');
silhouetteContour.appendChild(silhouetteContourPath);
stage.appendChild(silhouetteContour);

setupMeasure();
buildGUI();
rebuild();
requestAnimationFrame(tick);

window.addEventListener('resize', () => {
  refitAll();
});

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    invalidateLUTs();
    refitAll();
  });
}
