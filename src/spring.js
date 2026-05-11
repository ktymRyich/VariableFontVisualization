export function makeSpring(stiffness, damping, initial = 0) {
  let pos = initial;
  let vel = 0;
  return {
    step(dt, target) {
      if (dt <= 0) return pos;
      const h = Math.min(dt, 0.05);
      const force = stiffness * (target - pos) - damping * vel;
      vel += force * h;
      pos += vel * h;
      return pos;
    },
    set(v) {
      pos = v;
      vel = 0;
      return pos;
    },
    get value() {
      return pos;
    },
  };
}
