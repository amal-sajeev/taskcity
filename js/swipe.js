import { createSpring } from './spring.js';

export function attachSwipe(el, { onComplete, onDelete, getEnabled, threshold = 0.4, velocityThreshold = 0.6 } = {}) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0;
  let activeAxis = null;
  let dragging = false;
  let width = 0;
  let removed = false;

  const surface = el.querySelector('.task__surface') || el;
  const trailLeft = el.querySelector('.task__trail--left');
  const trailRight = el.querySelector('.task__trail--right');

  const spring = createSpring({ stiffness: 380, damping: 32 });
  let raf = null;
  let lastSpringT = 0;

  function applyOffset(x) {
    surface.style.transform = `translateX(${x}px)`;
    const w = width || el.offsetWidth || 1;
    const ratio = Math.max(-1, Math.min(1, x / w));
    if (trailRight) {
      trailRight.style.opacity = Math.max(0, ratio);
      trailRight.style.transform = `scaleX(${Math.max(0, ratio)})`;
    }
    if (trailLeft) {
      trailLeft.style.opacity = Math.max(0, -ratio);
      trailLeft.style.transform = `scaleX(${Math.max(0, -ratio)})`;
    }
    if (Math.abs(ratio) >= threshold) {
      el.classList.add('is-armed');
      el.dataset.armedDir = ratio > 0 ? 'right' : 'left';
    } else {
      el.classList.remove('is-armed');
      el.dataset.armedDir = '';
    }
  }

  function startSpring() {
    if (raf) return;
    lastSpringT = 0;
    raf = requestAnimationFrame(tick);
  }

  function stopSpring() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    lastSpringT = 0;
  }

  function tick(t) {
    raf = null;
    const dt = lastSpringT ? t - lastSpringT : 16;
    lastSpringT = t;
    const v = spring.tick(dt);
    applyOffset(v);
    if (!spring.isAtRest()) {
      raf = requestAnimationFrame(tick);
    } else {
      stopSpring();
    }
  }

  function pointerDown(e) {
    if (removed) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (getEnabled && !getEnabled()) return;
    if (e.target.closest('.task__complete') || e.target.closest('.task__menu') || e.target.closest('.task__handle')) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    lastT = performance.now();
    velocity = 0;
    activeAxis = null;
    width = el.offsetWidth;
    dragging = true;
    stopSpring();
  }

  function pointerMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (activeAxis === null) {
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (Math.max(adx, ady) < 8) return;
      if (ady > adx) {
        activeAxis = 'y';
        dragging = false;
        return;
      }
      activeAxis = 'x';
      try { surface.setPointerCapture(pointerId); } catch (_) {}
      el.classList.add('is-swiping');
    }
    if (activeAxis !== 'x') return;
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) velocity = (e.clientX - lastX) / dt;
    lastX = e.clientX;
    lastT = now;
    let next = dx;
    const w = width || el.offsetWidth || 1;
    if (Math.abs(next) > w) next = Math.sign(next) * (w + (Math.abs(next) - w) * 0.15);
    spring.setValue(next);
    applyOffset(next);
    e.preventDefault();
  }

  function pointerUp(e) {
    if (e && e.pointerId !== pointerId) return;
    if (!dragging && activeAxis !== 'x') return;
    dragging = false;
    el.classList.remove('is-swiping');
    try { surface.releasePointerCapture(pointerId); } catch (_) {}

    if (activeAxis !== 'x') {
      activeAxis = null;
      return;
    }
    activeAxis = null;

    const w = width || el.offsetWidth || 1;
    const cur = spring.value;
    const ratio = cur / w;
    const fired = Math.abs(ratio) >= threshold || Math.abs(velocity) > velocityThreshold;

    if (fired) {
      const dir = (cur > 0 || (Math.abs(cur) < 4 && velocity > 0)) ? 'right' : 'left';
      removed = true;
      el.classList.remove('is-armed');
      el.classList.add('is-flying');
      const fly = dir === 'right' ? w * 1.2 : -w * 1.2;
      spring.set(fly);
      startSpring();
      setTimeout(() => {
        if (dir === 'right' && onComplete) onComplete();
        else if (dir === 'left' && onDelete) onDelete();
      }, 220);
    } else {
      spring.set(0);
      startSpring();
      el.classList.remove('is-armed');
    }
  }

  surface.addEventListener('pointerdown', pointerDown);
  surface.addEventListener('pointermove', pointerMove);
  surface.addEventListener('pointerup', pointerUp);
  surface.addEventListener('pointercancel', pointerUp);

  return {
    destroy() {
      stopSpring();
      surface.removeEventListener('pointerdown', pointerDown);
      surface.removeEventListener('pointermove', pointerMove);
      surface.removeEventListener('pointerup', pointerUp);
      surface.removeEventListener('pointercancel', pointerUp);
    }
  };
}
