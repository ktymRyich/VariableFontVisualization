export function sculptDivider(synth, silh, presence, motion, params = {}) {
  const { waveFloorInv = 0.55, k0 = 0.35, k1 = 0.65 } = params;
  if (silh < 0) return synth;
  const sculpt = waveFloorInv * presence * (k0 + k1 * motion);
  const shape = 4 * synth * (1 - synth);
  const result = synth + sculpt * (silh - synth) * shape;
  return Math.max(0, Math.min(1, result));
}

export function detectSnap(prev, curr) {
  const vel = curr - prev;
  const fromBottom = prev <= 0.04 && vel > 0.003;
  const fromTop = prev >= 0.96 && vel < -0.003;
  return fromBottom || fromTop;
}
