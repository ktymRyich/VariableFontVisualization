import { sculptDivider } from './sculpt.js';

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

// A field is a set of per-column arrays the renderer applies uniformly.
// ctx provides: cols, w, h, colW, t, presence, motion, blend,
//   synth[], silTop[], silBottom[], coverage[], colMotion[],
//   centroidX, centroidY, state, EASINGS.
function makeField(ctx) {
  const { cols, synth, silTop, presence } = ctx;
  const f = {
    divider: new Array(cols),
    topTint: new Array(cols),
    botTint: new Array(cols),
    topWght: new Array(cols).fill(null),
    botWght: new Array(cols).fill(null),
    topDx: new Array(cols).fill(0),
    botDx: new Array(cols).fill(0),
    topDy: new Array(cols).fill(0),
    botDy: new Array(cols).fill(0),
    topOpacity: new Array(cols).fill(1),
    botOpacity: new Array(cols).fill(1),
  };
  for (let i = 0; i < cols; i++) {
    f.divider[i] = synth[i];
    const here = silTop[i] >= 0 ? presence : 0;
    f.topTint[i] = here;
    f.botTint[i] = here;
  }
  return f;
}

const sculpt = {
  label: 'sculpt — body bends the wave',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, silTop, presence, motion, blend, state } = ctx;
    const params = { waveFloorInv: 1 - state.waveFloor, k0: state.sculptK0, k1: state.sculptK1 };
    for (let i = 0; i < cols; i++) {
      f.divider[i] = sculptDivider(synth[i], silTop[i], presence * blend, motion, params);
    }
    return f;
  },
};

const fold = {
  label: 'fold — seam tracks your outline',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, silTop, presence, blend } = ctx;
    for (let i = 0; i < cols; i++) {
      if (silTop[i] >= 0) {
        const b = clamp(presence * blend);
        f.divider[i] = lerp(synth[i], silTop[i], b);
        f.topTint[i] = b;
        f.botTint[i] = b * 0.4;
      }
    }
    return f;
  },
};

const flood = {
  label: 'flood — you raise type from the floor',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, coverage, presence, blend } = ctx;
    for (let i = 0; i < cols; i++) {
      const cov = clamp(coverage[i] * 3);
      const raise = cov * blend * presence;
      // pull the seam up so the bottom row towers where the body stands
      f.divider[i] = clamp(lerp(synth[i], 0.12, raise), 0, 1);
      f.botTint[i] = raise;
      f.topTint[i] = raise * 0.2;
    }
    return f;
  },
};

const ink = {
  label: 'ink — your body weights the letters',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, coverage, silTop, presence, blend, camActive, state } = ctx;
    const base = camActive ? 40 : state.wght;
    const black = 1000;
    for (let i = 0; i < cols; i++) {
      // calm, shallow wave so weight reads as the main event
      f.divider[i] = lerp(0.5, synth[i], 0.4);
      const cov = clamp(coverage[i] * 2.5) * presence * blend;
      const wght = lerp(base, black, cov);
      f.topWght[i] = wght;
      f.botWght[i] = wght;
      f.topTint[i] = silTop[i] >= 0 ? cov : 0;
      f.botTint[i] = f.topTint[i];
    }
    return f;
  },
};

const ripple = {
  label: 'ripple — waves spread from where you are',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, centroidX, presence, motion, blend, t } = ctx;
    const src = centroidX >= 0 ? centroidX * (cols - 1) : (cols - 1) / 2;
    const env = clamp(presence * blend) * (0.4 + 0.6 * motion);
    const speed = 3.5;
    const k = 1.1;
    for (let i = 0; i < cols; i++) {
      const d = Math.abs(i - src);
      const decay = Math.exp(-d * 0.25);
      const pulse = Math.sin(t * speed - d * k) * 0.5 * env * decay;
      f.divider[i] = clamp(synth[i] + pulse, 0, 1);
      f.topTint[i] = clamp(Math.abs(pulse) * 2.5);
      f.botTint[i] = f.topTint[i];
    }
    return f;
  },
};

const scatter = {
  label: 'scatter — motion shatters the grid',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, colMotion, h, motion, blend, t } = ctx;
    for (let i = 0; i < cols; i++) {
      f.divider[i] = synth[i];
      const m = clamp(colMotion[i] * 1.5) * blend;
      const amp = m * h * 0.18;
      const wobX = Math.sin(t * 11 + i * 2.1);
      const wobY = Math.cos(t * 9 + i * 1.7);
      f.topDy[i] = -amp + wobY * amp * 0.4;
      f.botDy[i] = amp + wobY * amp * 0.4;
      f.topDx[i] = wobX * amp * 0.5;
      f.botDx[i] = -wobX * amp * 0.5;
      f.topTint[i] = clamp(m * 1.5);
      f.botTint[i] = f.topTint[i];
    }
    return f;
  },
};

const magnet = {
  label: 'magnet — letters cling to your contour',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, silTop, h, presence, blend } = ctx;
    for (let i = 0; i < cols; i++) {
      if (silTop[i] >= 0) {
        const b = clamp(presence * blend);
        f.divider[i] = lerp(synth[i], silTop[i], b * 0.85);
        const pull = b * h * 0.22;
        f.topDy[i] = pull; // top row slides down toward the seam
        f.botDy[i] = -pull; // bottom row slides up toward the seam
        f.topTint[i] = b;
        f.botTint[i] = b;
      }
    }
    return f;
  },
};

const reveal = {
  label: 'reveal — you carry the word',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, coverage, silTop, silBottom, presence, blend, camActive } = ctx;
    const dim = camActive ? 0.08 : 1;
    for (let i = 0; i < cols; i++) {
      f.divider[i] = synth[i];
      const cov = clamp(coverage[i] * 4) * blend;
      const div = f.divider[i];
      // approximate how much of each row the body occupies
      const top = silTop[i] >= 0 ? clamp((div - silTop[i]) / Math.max(div, 0.001)) : 0;
      const bot = silBottom[i] >= 0 ? clamp((silBottom[i] - div) / Math.max(1 - div, 0.001)) : 0;
      f.topOpacity[i] = lerp(dim, 1, clamp(top * 1.2) * cov);
      f.botOpacity[i] = lerp(dim, 1, clamp(bot * 1.2) * cov);
      f.topTint[i] = clamp(top) * presence;
      f.botTint[i] = clamp(bot) * presence;
    }
    return f;
  },
};

const echo = {
  label: 'echo — movement leaves a trail',
  usesTrail: true,
  compute(ctx) {
    // divider follows the body like fold; the trail canvas (handled in main)
    // paints fading copies of the seam.
    return fold.compute(ctx);
  },
};

const pulse = {
  label: 'pulse — the room breathes with you',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, presence, motion, blend, t, EASINGS } = ctx;
    const amp = 0.5 * (0.25 + 0.75 * clamp(presence * blend));
    const freq = 0.6 + 2.4 * motion;
    const raw = (Math.sin(t * freq) + 1) / 2;
    const eased = (EASINGS.expoInOut || ((x) => x))(raw);
    const unified = clamp(0.5 + (eased - 0.5) * 2 * amp);
    const beat = clamp(presence * blend);
    for (let i = 0; i < cols; i++) {
      f.divider[i] = lerp(synth[i], unified, beat);
      f.topTint[i] = beat * Math.abs(eased - 0.5) * 2;
      f.botTint[i] = f.topTint[i];
    }
    return f;
  },
};

export const INTERACTIONS = {
  sculpt,
  fold,
  flood,
  ink,
  ripple,
  scatter,
  magnet,
  reveal,
  echo,
  pulse,
};

export const INTERACTION_NAMES = Object.keys(INTERACTIONS);
