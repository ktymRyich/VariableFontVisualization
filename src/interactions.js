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

// shared "fall onto target" helper: returns { div, tint, dy } given phase 0..1
function fallCycle(phase, target, h, profile) {
  const { fall, hold, impact = 0, gravity = 2, bounce = 0, holdFade = 0.6 } = profile;
  const reset = Math.max(0.01, 1 - fall - hold - impact);
  if (phase < fall) {
    const u = phase / fall;
    const eased = gravity <= 2 ? u * u : gravity <= 3 ? u * u * u : Math.pow(u, gravity);
    return { div: eased * target, tint: u * 0.3, dy: 0 };
  }
  if (phase < fall + impact) {
    const u = (phase - fall) / impact;
    const over = Math.sin(u * Math.PI) * bounce;
    return { div: target + over * (1 - u), tint: 1, dy: -Math.sin(u * Math.PI) * h * 0.05 };
  }
  if (phase < fall + impact + hold) {
    const local = (phase - fall - impact) / hold;
    return { div: target, tint: 1 - holdFade * local, dy: 0 };
  }
  const u = (phase - fall - impact - hold) / reset;
  return { div: (1 - u) * target, tint: (1 - holdFade) * (1 - u), dy: 0 };
}

function hashOffset(i, salt) {
  const r = Math.sin(i * 7919.3 + salt) * 43758.5453;
  return r - Math.floor(r);
}

const drop = {
  label: 'drop — letters fall and land on you',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, silTop, presence, blend, t, h, state, camActive } = ctx;
    const cycle = Math.max(0.5, state.period * 0.5);
    const profile = { fall: 0.55, hold: 0.30, gravity: 2 };
    for (let i = 0; i < cols; i++) {
      const colT = ((t + i * cycle * 0.13) % cycle + cycle) % cycle;
      const r = fallCycle(colT / cycle, silTop[i] >= 0 ? silTop[i] : 1, h, profile);
      // ambient: always falls. When body present, blend slightly more toward fall.
      const ambient = !camActive ? 1 : Math.min(1, presence * blend + 0.5);
      f.divider[i] = clamp(lerp(synth[i], r.div, ambient));
      f.topTint[i] = r.tint * ambient;
      f.botTint[i] = 0;
    }
    return f;
  },
};

const rain = {
  label: 'rain — many small drops, dense',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, silTop, presence, t, h, state, camActive, blend } = ctx;
    const baseCycle = Math.max(0.32, state.period * 0.22);
    const profile = { fall: 0.65, hold: 0.12, gravity: 2 };
    for (let i = 0; i < cols; i++) {
      const off = hashOffset(i, 13.7);
      const variance = 0.7 + 0.6 * hashOffset(i, 41.3);
      const cycleI = baseCycle * variance;
      const colT = ((t + off * cycleI) % cycleI + cycleI) % cycleI;
      const r = fallCycle(colT / cycleI, silTop[i] >= 0 ? silTop[i] : 1, h, profile);
      f.divider[i] = clamp(r.div);
      f.topTint[i] = r.tint * 0.7 * (camActive ? Math.min(1, presence * blend + 0.4) : 1);
      f.botTint[i] = 0;
      f.topWght[i] = 220; // thin, droplet-like
    }
    return f;
  },
};

const catcher = {
  label: 'catcher — falls only where you stand',
  compute(ctx) {
    const f = makeField(ctx);
    const { cols, synth, silTop, presence, blend, t, h, state } = ctx;
    const cycle = Math.max(0.6, state.period * 0.6);
    const profile = { fall: 0.48, impact: 0.08, hold: 0.32, gravity: 3, bounce: 0.05 };
    for (let i = 0; i < cols; i++) {
      if (silTop[i] < 0) {
        f.divider[i] = synth[i];
        f.topTint[i] = 0;
        f.botTint[i] = 0;
        continue;
      }
      const colT = ((t + i * cycle * 0.17) % cycle + cycle) % cycle;
      const r = fallCycle(colT / cycle, silTop[i], h, profile);
      const b = clamp(presence * blend);
      f.divider[i] = clamp(lerp(synth[i], r.div, b));
      f.topTint[i] = r.tint * b;
      f.botTint[i] = r.tint * b * 0.4;
      f.topDy[i] = r.dy * b;
      f.topWght[i] = lerp(state.wght, 900, b); // heavy when caught
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
  drop,
  rain,
  catcher,
};

export const INTERACTION_NAMES = Object.keys(INTERACTIONS);
