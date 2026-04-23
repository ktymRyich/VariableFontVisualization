import { mulberry32 } from '../rng.js';

export function bspSplit(width, height, seed, options = {}) {
  const {
    targetCount = 15,
    minSize = 60,
    ratioMin = 0.3,
    ratioMax = 0.7,
  } = options;

  const rng = mulberry32(seed);
  const rects = [{ x: 0, y: 0, w: width, h: height }];
  let guard = 0;

  while (rects.length < targetCount && guard++ < 2000) {
    rects.sort((a, b) => b.w * b.h - a.w * a.h);

    let idx = -1;
    for (let i = 0; i < rects.length; i++) {
      if (rects[i].w >= minSize * 2 || rects[i].h >= minSize * 2) {
        idx = i;
        break;
      }
    }
    if (idx < 0) break;

    const target = rects.splice(idx, 1)[0];
    const canCutVertical = target.w >= minSize * 2;
    const canCutHorizontal = target.h >= minSize * 2;

    let cutVertical;
    if (canCutVertical && canCutHorizontal) {
      cutVertical = target.w >= target.h ? rng() < 0.75 : rng() < 0.25;
    } else {
      cutVertical = canCutVertical;
    }

    const ratio = ratioMin + rng() * (ratioMax - ratioMin);

    if (cutVertical) {
      const w1 = Math.max(minSize, Math.min(target.w - minSize, target.w * ratio));
      rects.push({ x: target.x, y: target.y, w: w1, h: target.h });
      rects.push({ x: target.x + w1, y: target.y, w: target.w - w1, h: target.h });
    } else {
      const h1 = Math.max(minSize, Math.min(target.h - minSize, target.h * ratio));
      rects.push({ x: target.x, y: target.y, w: target.w, h: h1 });
      rects.push({ x: target.x, y: target.y + h1, w: target.w, h: target.h - h1 });
    }
  }

  return rects;
}
