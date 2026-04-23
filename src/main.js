import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';
import { mulberry32 } from './rng.js';
import { bspSplit } from './splitters/bsp.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const splitters = {
  bsp: bspSplit,
};

const FONT_AXES = [
  { tag: 'WGT1', min: 100, max: 800, default: 400, step: 1 },
  { tag: 'WGT2', min: 100, max: 800, default: 400, step: 1 },
  { tag: 'WGT3', min: 100, max: 800, default: 400, step: 1 },
  { tag: 'WGT4', min: 100, max: 800, default: 400, step: 1 },
  { tag: 'SIZE', min: 0, max: 100, default: 50, step: 1 },
  { tag: 'PROP', min: 0, max: 100, default: 50, step: 1 },
  { tag: 'EXTD', min: 0, max: 100, default: 50, step: 1 },
  { tag: 'YPOS', min: -400, max: 400, default: 0, step: 1 },
];

const state = {
  algorithm: 'bsp',
  seed: 1,
  targetCount: 15,
  showBorders: true,
  fitRatio: 0.85,
};
for (const axis of FONT_AXES) state[axis.tag] = axis.default;

const stage = document.getElementById('stage');

function relayout() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const splitter = splitters[state.algorithm];
  const rects = splitter(w, h, state.seed, { targetCount: state.targetCount });

  const letterRng = mulberry32((state.seed ^ 0x9e3779b9) >>> 0);

  stage.innerHTML = '';
  for (const r of rects) {
    const cell = document.createElement('div');
    cell.className = 'cell' + (state.showBorders ? ' bordered' : '');
    cell.style.left = r.x + 'px';
    cell.style.top = r.y + 'px';
    cell.style.width = r.w + 'px';
    cell.style.height = r.h + 'px';
    cell.style.fontSize = Math.min(r.w, r.h) * state.fitRatio + 'px';
    cell.textContent = ALPHABET[Math.floor(letterRng() * ALPHABET.length)];
    stage.appendChild(cell);
  }
  applyFontVariation();
}

function applyFontVariation() {
  const parts = FONT_AXES.map((a) => `"${a.tag}" ${state[a.tag]}`);
  stage.style.fontVariationSettings = parts.join(', ');
}

function buildGUI() {
  const gui = new GUI({ title: 'Controls' });

  const layout = gui.addFolder('Layout');
  layout.add(state, 'algorithm', Object.keys(splitters)).onChange(relayout);
  const seedCtrl = layout.add(state, 'seed', 0, 99999, 1).onChange(relayout);
  layout.add(state, 'targetCount', 2, 40, 1).name('target count').onChange(relayout);
  layout.add(state, 'showBorders').name('borders').onChange(relayout);
  layout.add(state, 'fitRatio', 0.3, 1.2, 0.01).name('fit ratio').onChange(relayout);
  layout
    .add(
      {
        randomize: () => {
          state.seed = Math.floor(Math.random() * 100000);
          seedCtrl.updateDisplay();
          relayout();
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

buildGUI();
relayout();

window.addEventListener('resize', () => {
  relayout();
});

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(relayout);
}
