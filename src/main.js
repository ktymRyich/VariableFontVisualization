import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';
import { mulberry32 } from './rng.js';
import { bspSplit } from './splitters/bsp.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MODES = ['nikeBars', 'bsp'];

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
  { tag: 'WGT1', min: 100, max: 800, default: 600, step: 1 },
  { tag: 'WGT2', min: 100, max: 800, default: 600, step: 1 },
  { tag: 'WGT3', min: 100, max: 800, default: 600, step: 1 },
  { tag: 'WGT4', min: 100, max: 800, default: 600, step: 1 },
  { tag: 'SIZE', min: 0, max: 100, default: 50, step: 1 },
  { tag: 'PROP', min: 0, max: 100, default: 50, step: 1 },
  { tag: 'EXTD', min: 0, max: 100, default: 50, step: 1 },
  { tag: 'YPOS', min: -400, max: 400, default: 0, step: 1 },
];

const state = {
  mode: 'nikeBars',
  seed: 1,
  targetCount: 15,
  text: 'NIKE',
  playing: true,
  period: 4.0,
  easing: 'sineInOut',
  manualTime: 0.5,
  showBorders: true,
  fitRatio: 1.0,
  uniformScale: false,
};
for (const axis of FONT_AXES) state[axis.tag] = axis.default;

const stage = document.getElementById('stage');

const bboxCache = new Map();
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
  measureText.setAttribute('font-size', '100');
  measureText.setAttribute('dominant-baseline', 'alphabetic');
  measureSvg.appendChild(measureText);
  stage.appendChild(measureSvg);
}

function measureChar(ch) {
  if (bboxCache.has(ch)) return bboxCache.get(ch);
  measureText.textContent = ch;
  let bbox;
  try {
    bbox = measureText.getBBox();
  } catch {
    return null;
  }
  if (!bbox || bbox.width === 0 || bbox.height === 0) return null;
  const result = { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
  bboxCache.set(ch, result);
  return result;
}

function invalidateMeasurements() {
  bboxCache.clear();
}

let cells = [];

function makeCell(ch) {
  const el = document.createElement('div');
  el.className = 'cell' + (state.showBorders ? ' bordered' : '');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('font-size', '100');
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

function fitCell(c, w, h) {
  c.el.style.width = w + 'px';
  c.el.style.height = h + 'px';
  c.svg.setAttribute('width', w);
  c.svg.setAttribute('height', h);
  c.svg.setAttribute('viewBox', `0 0 ${Math.max(w, 0.0001)} ${Math.max(h, 0.0001)}`);
  const bbox = measureChar(c.char);
  if (!bbox) return;
  let scaleX = (w / bbox.width) * state.fitRatio;
  let scaleY = (h / bbox.height) * state.fitRatio;
  if (!isFinite(scaleX)) scaleX = 0;
  if (!isFinite(scaleY)) scaleY = 0;
  if (state.uniformScale) {
    const s = Math.min(scaleX, scaleY);
    scaleX = s;
    scaleY = s;
  }
  const cx = w / 2;
  const cy = h / 2;
  const bx = bbox.x + bbox.width / 2;
  const by = bbox.y + bbox.height / 2;
  c.text.setAttribute(
    'transform',
    `translate(${cx} ${cy}) scale(${scaleX} ${scaleY}) translate(${-bx} ${-by})`
  );
}

function positionCell(c, x, y) {
  c.el.style.left = x + 'px';
  c.el.style.top = y + 'px';
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
  const div = computeDividerY();
  const topH = h * div;
  const botH = h - topH;
  for (const c of cells) {
    const x = c.col * colW;
    const y = c.row === 0 ? 0 : topH;
    const rh = c.row === 0 ? topH : botH;
    positionCell(c, x, y);
    fitCell(c, colW, rh);
  }
}

let virtualTime = 1.0;
let lastFrame = 0;

function tick(now) {
  requestAnimationFrame(tick);
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  if (state.mode === 'nikeBars') {
    if (state.playing) virtualTime += dt;
    updateNikeLayout();
  }
}

function computeDividerY() {
  if (state.playing) {
    return easedDivider(virtualTime, state.period, state.easing);
  }
  return state.manualTime;
}

function easedDivider(t, period, easingName) {
  const phase = (((t / period) % 1) + 1) % 1;
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const fn = EASINGS[easingName] || EASINGS.sineInOut;
  return fn(tri);
}

function applyFontVariation() {
  const parts = FONT_AXES.map((a) => `"${a.tag}" ${state[a.tag]}`);
  stage.style.fontVariationSettings = parts.join(', ');
  invalidateMeasurements();
  if (state.mode === 'bsp') refitBSP();
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
  common.add(state, 'fitRatio', 0.5, 1.1, 0.01).name('fit ratio').onChange(refitAll);
  common.add(state, 'uniformScale').name('uniform scale').onChange(refitAll);

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

setupMeasure();
buildGUI();
applyFontVariation();
rebuild();
requestAnimationFrame(tick);

window.addEventListener('resize', () => {
  if (state.mode === 'bsp') buildBSP();
  else updateNikeLayout();
});

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    invalidateMeasurements();
    refitAll();
  });
}
