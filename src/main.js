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

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MODES = ['nikeBars', 'bsp'];
const REF_FS = 100;
const LUT_SAMPLES = 32;
const WDTH_MIN = 100;
const WDTH_MAX = 7500;

const EASINGS = {
  linear: (t) => t,
  sineInOut: (t) => (1 - Math.cos(Math.PI * t)) / 2,
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  expoInOut: (t) =>
    t === 0
      ? 0
      : t === 1
      ? 1
      : t < 0.5
      ? Math.pow(2, 20 * t - 10) / 2
      : (2 - Math.pow(2, -20 * t + 10)) / 2,
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
  easing: 'expoInOut',
  hold: 0.5,
  phasePattern: 'leftToRight',
  phaseUnit: 0.05,
  phaseSeed: 1,
  manualTime: 0.5,
  showBorders: true,
  fitRatio: 1.0,
  cameraEnabled: false,
  mirrorCamera: true,
  silhouetteBlend: 1.0,
  motionInfluence: 0.7,
  showPreview: true,
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
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'alphabetic');
  text.textContent = ch;
  svg.appendChild(text);
  el.appendChild(svg);
  return { el, svg, text, char: ch };
}

function clearCells() {
  for (const c of cells) c.el.remove();
  cells = [];
}

function positionCell(c, x, y) {
  c.el.style.left = x + 'px';
  c.el.style.top = y + 'px';
}

function fitCell(c, natW, natH, actW = natW, actH = natH) {
  c.el.style.width = actW + 'px';
  c.el.style.height = actH + 'px';
  c.svg.setAttribute('width', actW);
  c.svg.setAttribute('height', actH);
  c.svg.setAttribute('viewBox', `0 0 ${Math.max(natW, 1)} ${Math.max(natH, 1)}`);
  c.svg.setAttribute('preserveAspectRatio', 'none');

  if (natW <= 0 || natH <= 0) {
    c.text.setAttribute('font-size', '0');
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

  c.text.setAttribute('font-size', fontSize);
  c.text.setAttribute('x', cx);
  c.text.setAttribute('y', cy);
  c.text.style.fontVariationSettings = `"wght" ${state.wght}, "wdth" ${sample.wdth}, "SIZE" ${state.SIZE}`;
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

  const camActive = state.cameraEnabled && cameraState.ready;
  const motion = camActive ? cameraState.motion : 0;
  const presence = camActive ? cameraState.presence : 0;
  const motionT = motion * state.motionInfluence;
  const periodAdj = state.period * (1 - motionT * 0.75);
  const holdAdj = state.hold * (1 - motionT);
  const holdFrac = Math.min(0.49, Math.max(0, holdAdj / Math.max(periodAdj, 0.01)));

  const basePhase = state.playing ? phaseAccum : state.manualTime;

  const colTopH = new Array(cols);
  for (let i = 0; i < cols; i++) {
    const offsetFrac = getColPhaseOffset(i, cols);
    const phase = (((basePhase - offsetFrac) % 1) + 1) % 1;
    const synthDiv = easedDividerByPhase(phase, state.easing, holdFrac);

    let finalDiv = synthDiv;
    if (camActive && cameraState.silhouetteDivs.length === cols) {
      const blend = Math.min(1, presence * state.silhouetteBlend);
      const silh = cameraState.silhouetteDivs[i];
      finalDiv = synthDiv * (1 - blend) + silh * blend;
    }

    colTopH[i] = Math.round(h * finalDiv);
  }

  for (const c of cells) {
    const x = c.col * colW;
    const topH = colTopH[c.col];
    const botH = h - topH;
    const y = c.row === 0 ? 0 : topH;
    const rh = c.row === 0 ? topH : botH;
    positionCell(c, x, y);
    fitCell(c, colW, h, colW, rh);
  }
}

let phaseAccum = 0.25;
let lastFrame = 0;

function tick(now) {
  requestAnimationFrame(tick);
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;

  if (state.cameraEnabled && cameraState.ready) {
    processFrame(state.text.length || 1, state.mirrorCamera);
  }

  if (state.mode === 'nikeBars') {
    if (state.playing) {
      const motion = (state.cameraEnabled && cameraState.ready) ? cameraState.motion : 0;
      const motionT = motion * state.motionInfluence;
      const periodAdj = state.period * (1 - motionT * 0.75);
      phaseAccum = (phaseAccum + dt / Math.max(periodAdj, 0.01)) % 1;
    }
    updateNikeLayout();
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
  if (state.mode === 'bsp') buildBSP();
  else buildNike();
}

function refitAll() {
  if (state.mode === 'bsp') refitBSP();
  else updateNikeLayout();
}

function applyBorders() {
  for (const c of cells) c.el.classList.toggle('bordered', state.showBorders);
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
  cam.add(state, 'silhouetteBlend', 0, 1, 0.01).name('silhouette blend');
  cam.add(state, 'motionInfluence', 0, 1, 0.01).name('motion influence');
  cam.add(state, 'showPreview').name('show preview').onChange((v) => {
    if (previewEl) previewEl.hidden = !v;
  });

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

setupMeasure();
buildGUI();
rebuild();
requestAnimationFrame(tick);

window.addEventListener('resize', () => {
  if (state.mode === 'bsp') buildBSP();
  else updateNikeLayout();
});

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    invalidateLUTs();
    refitAll();
  });
}
