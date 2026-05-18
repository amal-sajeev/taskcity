export function createSpring({ stiffness = 280, damping = 30, mass = 1, initial = 0 } = {}) {
  let value = initial;
  let velocity = 0;
  let target = initial;

  return {
    set(t) {
      target = t;
    },
    setValue(v) {
      value = v;
      velocity = 0;
    },
    setBoth(v, t = v) {
      value = v;
      target = t;
      velocity = 0;
    },
    tick(dtMs) {
      const dt = Math.min(0.064, Math.max(0, dtMs) / 1000);
      const fSpring = -stiffness * (value - target);
      const fDamp = -damping * velocity;
      const a = (fSpring + fDamp) / mass;
      velocity += a * dt;
      value += velocity * dt;
      return value;
    },
    isAtRest(eps = 0.05) {
      return Math.abs(target - value) < eps && Math.abs(velocity) < eps;
    },
    snapToTarget() {
      value = target;
      velocity = 0;
    },
    get value() { return value; },
    get target() { return target; },
    get velocity() { return velocity; }
  };
}

export function createSpringDriver(spring, onTick, onRest) {
  let raf = null;
  let lastT = 0;

  function loop(t) {
    raf = null;
    const dt = lastT ? t - lastT : 16;
    lastT = t;
    const v = spring.tick(dt);
    if (onTick) onTick(v);
    if (!spring.isAtRest()) {
      raf = requestAnimationFrame(loop);
    } else {
      lastT = 0;
      if (onRest) onRest(v);
    }
  }

  function start() {
    if (raf) return;
    lastT = 0;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    lastT = 0;
  }

  return { start, stop };
}
