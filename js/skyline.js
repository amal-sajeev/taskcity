import {
  drawIsoBuilding,
  drawIsoFloor,
  drawIsoFloorLabel,
  drawIsoGhost,
  drawIsoBaseGlow,
  drawIsoFoundation,
  drawIsoWireframe,
  drawIsoCrane,
  hexToRgba,
  mulberry32,
  generateBuilding
} from './buildings.js';
import {
  computeCityLayout,
  cellToWorld,
  makeProjector,
  computeCameraFit,
  computeCameraFitFocused,
  nextCellForDistrict
} from './layout.js';
import { seedFromString } from './tasks.js';
import { showToast } from './toast.js';
import { createSpring } from './spring.js';
import { settings } from './settings.js';

const STAR_COUNT_FAR = 80;
const STAR_COUNT_NEAR = 40;
const TOP_INSET_DESKTOP = 64;
const TOP_INSET_MOBILE = 56;
const BOTTOM_INSET_MOBILE = 16;

export function mountSkyline({ canvas }) {
  const ctx = canvas.getContext('2d');
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let cssW = 0;
  let cssH = 0;
  let lastData = null;
  let cachedLayout = null;
  const animations = new Map();
  const particles = [];
  const sparks = [];
  const beams = [];
  const traces = [];
  const highlights = [];
  let rafHandle = null;
  let mountTime = performance.now();
  let lastFrameT = mountTime;
  const listeners = new Map();
  const punchSpring = createSpring({ stiffness: 220, damping: 22 });

  // Camera as three independent springs (in CSS px; multiplied by dpr at draw time).
  const tileHSpring = createSpring({ stiffness: 110, damping: 22 });
  const originXSpring = createSpring({ stiffness: 110, damping: 22 });
  const originYSpring = createSpring({ stiffness: 110, damping: 22 });
  let cameraInited = false;
  let focusedDistrictId = null;

  // ── User-controlled camera (pan / zoom) ────────────────────────────────
  // When the user drags or pinches/wheels, we leave auto-fit and hold their
  // viewpoint until a district chip is selected or reset is invoked.
  let manualMode = false;
  const POINTERS = new Map();
  let lastPanPoint = null;
  let lastPinchDist = 0;
  let lastPinchCenter = null;
  let lastTapTime = 0;
  let lastTapPoint = null;
  const TILE_H_MIN = 4;
  const TILE_H_MAX = 80;

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.error(err); }
    }
  }

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    cssW = rect.width;
    cssH = rect.height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (cachedLayout) applyCameraTargets({ snap: true });
    emit('resize', { width: cssW, height: cssH, dpr });
  }

  let resizeTimer = null;
  function debouncedResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      render(lastData);
    }, 200);
  }

  window.addEventListener('resize', debouncedResize);
  window.addEventListener('orientationchange', debouncedResize);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => debouncedResize());
    ro.observe(canvas);
  }

  resize();

  function isDesktop() {
    return window.matchMedia('(min-width: 900px)').matches;
  }

  function reduced() {
    return settings.isReduced();
  }

  function getDimensions() {
    return { width: cssW, height: cssH, dpr };
  }

  function refreshLayout(data) {
    cachedLayout = computeCityLayout(data.districts);
    applyCameraTargets({ snap: !cameraInited });
  }

  function targetCameraParams() {
    if (!cachedLayout || cssW === 0 || cssH === 0) return null;
    const desktop = isDesktop();
    const topInset = desktop ? TOP_INSET_DESKTOP : TOP_INSET_MOBILE;
    const bottomInset = desktop ? 24 : BOTTOM_INSET_MOBILE;
    if (focusedDistrictId) {
      return computeCameraFitFocused({
        layout: cachedLayout,
        focusedId: focusedDistrictId,
        cssW,
        cssH,
        topInset,
        bottomInset
      });
    }
    return computeCameraFit({
      layout: cachedLayout,
      cssW,
      cssH,
      topInset,
      bottomInset
    });
  }

  function applyCameraTargets({ snap = false, force = false } = {}) {
    // Once the user takes manual control we leave their view alone until
    // resetCamera() / setFocus() explicitly re-engages auto-fit.
    if (manualMode && !force) return;
    const t = targetCameraParams();
    if (!t) return;
    const reduceMotion = reduced() || snap || !cameraInited;
    if (reduceMotion) {
      tileHSpring.setBoth(t.tileH);
      originXSpring.setBoth(t.originX);
      originYSpring.setBoth(t.originY);
      cameraInited = true;
    } else {
      tileHSpring.set(t.tileH);
      originXSpring.set(t.originX);
      originYSpring.set(t.originY);
    }
    scheduleTick();
  }

  function getCamera(offX, offY) {
    const tileH = tileHSpring.value * dpr;
    const tileW = tileH * 2;
    const elevScale = tileH * 1.6;
    const originX = originXSpring.value * dpr + offX;
    const originY = originYSpring.value * dpr + offY;
    return {
      tileW,
      tileH,
      originX,
      originY,
      elevScale,
      project: makeProjector({ tileW, tileH, originX, originY, elevScale })
    };
  }

  function setFocus(districtId) {
    focusedDistrictId = districtId || null;
    manualMode = false;
    applyCameraTargets({ force: true });
    emit('cameramode', { manual: false });
  }

  // ── Pan / zoom helpers ──────────────────────────────────────────────────
  function canvasPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // Inverse projection at the ground plane (wz = 0) in CSS px space.
  function inverseProjectAtGround(px, py) {
    const tileH = tileHSpring.value;
    const originX = originXSpring.value;
    const originY = originYSpring.value;
    if (tileH <= 0) return null;
    const a = (px - originX) / tileH;        // wx - wy   (since tileW/2 = tileH)
    const b = (py - originY) / (tileH / 2);  // wx + wy
    return { wx: (a + b) / 2, wy: (b - a) / 2 };
  }

  function setManualCameraInstant({ tileH, originX, originY }) {
    if (!manualMode) {
      manualMode = true;
      emit('cameramode', { manual: true });
    }
    tileHSpring.setBoth(tileH);
    originXSpring.setBoth(originX);
    originYSpring.setBoth(originY);
    cameraInited = true;
    scheduleTick();
  }

  function panByPx(dx, dy) {
    setManualCameraInstant({
      tileH: tileHSpring.value,
      originX: originXSpring.value + dx,
      originY: originYSpring.value + dy
    });
  }

  function zoomAround(px, py, factor) {
    const world = inverseProjectAtGround(px, py);
    if (!world) return;
    const newTileH = Math.max(TILE_H_MIN, Math.min(TILE_H_MAX, tileHSpring.value * factor));
    if (newTileH === tileHSpring.value) return;
    // Solve for origin so (world.wx, world.wy) still projects back to (px, py).
    const newOriginX = px - (world.wx - world.wy) * newTileH;
    const newOriginY = py - (world.wx + world.wy) * (newTileH / 2);
    setManualCameraInstant({ tileH: newTileH, originX: newOriginX, originY: newOriginY });
  }

  function resetCamera() {
    manualMode = false;
    applyCameraTargets({ snap: false, force: true });
    emit('cameramode', { manual: false });
  }

  function isManual() {
    return manualMode;
  }

  // ── Pointer / wheel input ───────────────────────────────────────────────
  function onPointerDown(e) {
    POINTERS.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    if (POINTERS.size === 1) {
      lastPanPoint = { x: e.clientX, y: e.clientY };
      // Double-tap to reset.
      const now = performance.now();
      const dt = now - lastTapTime;
      const dp = lastTapPoint ? Math.hypot(e.clientX - lastTapPoint.x, e.clientY - lastTapPoint.y) : Infinity;
      if (dt < 320 && dp < 30) {
        resetCamera();
        lastTapTime = 0;
        lastTapPoint = null;
      } else {
        lastTapTime = now;
        lastTapPoint = { x: e.clientX, y: e.clientY };
      }
      canvas.style.cursor = 'grabbing';
    } else if (POINTERS.size === 2) {
      const [a, b] = [...POINTERS.values()];
      lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      lastPinchCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      lastPanPoint = null;
    }
  }

  function onPointerMove(e) {
    if (!POINTERS.has(e.pointerId)) return;
    POINTERS.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (POINTERS.size === 1 && lastPanPoint) {
      const dx = e.clientX - lastPanPoint.x;
      const dy = e.clientY - lastPanPoint.y;
      if (dx || dy) {
        panByPx(dx, dy);
        lastPanPoint = { x: e.clientX, y: e.clientY };
      }
    } else if (POINTERS.size === 2) {
      const [a, b] = [...POINTERS.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (lastPinchDist > 0) {
        const factor = dist / lastPinchDist;
        const rect = canvas.getBoundingClientRect();
        zoomAround(center.x - rect.left, center.y - rect.top, factor);
        if (lastPinchCenter) {
          const pdx = center.x - lastPinchCenter.x;
          const pdy = center.y - lastPinchCenter.y;
          if (pdx || pdy) panByPx(pdx, pdy);
        }
      }
      lastPinchDist = dist;
      lastPinchCenter = center;
    }
  }

  function onPointerUp(e) {
    POINTERS.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (POINTERS.size === 1) {
      const [only] = [...POINTERS.values()];
      lastPanPoint = { x: only.x, y: only.y };
      lastPinchDist = 0;
      lastPinchCenter = null;
    } else if (POINTERS.size === 0) {
      lastPanPoint = null;
      lastPinchDist = 0;
      lastPinchCenter = null;
      canvas.style.cursor = 'grab';
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const pt = canvasPointFromEvent(e);
    // Exponential mapping keeps the zoom feel symmetric regardless of speed.
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAround(pt.x, pt.y, factor);
  }

  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  function getLayout() {
    return cachedLayout;
  }

  function render(data) {
    if (data) {
      const districtsChanged = !cachedLayout || hashDistricts(data.districts) !== hashDistricts(lastData ? lastData.districts : []);
      lastData = data;
      if (districtsChanged) refreshLayout(data);
    }
    if (!lastData) return;
    scheduleTick();
  }

  function drawSky(width, height) {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#04060f');
    grad.addColorStop(0.55, '#070d1f');
    grad.addColorStop(1, '#0d1535');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  let _starsCache = null;
  function ensureStars(seed) {
    if (_starsCache && _starsCache.seed === seed && _starsCache.w === cssW && _starsCache.h === cssH) {
      return _starsCache;
    }
    const rng = mulberry32(seed);
    const far = [];
    const near = [];
    for (let i = 0; i < STAR_COUNT_FAR; i++) {
      far.push({
        x: rng() * cssW,
        y: rng() * cssH * 0.7,
        r: rng() * 1.0 + 0.3,
        a: 0.18 + rng() * 0.4,
        twinkle: rng() * 6.28
      });
    }
    for (let i = 0; i < STAR_COUNT_NEAR; i++) {
      near.push({
        x: rng() * cssW,
        y: rng() * cssH * 0.6,
        r: rng() * 1.4 + 0.5,
        a: 0.3 + rng() * 0.5,
        twinkle: rng() * 6.28
      });
    }
    _starsCache = { seed, w: cssW, h: cssH, far, near };
    return _starsCache;
  }

  function drawStars(width, height, seed, time, sway) {
    const stars = ensureStars(seed);
    const tFar = -sway.x * 0.2;
    const tNear = -sway.x * 0.6;
    for (const s of stars.far) {
      const a = s.a * (0.7 + 0.3 * Math.sin(time * 0.001 + s.twinkle));
      ctx.fillStyle = `rgba(220,230,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc((s.x + tFar) * dpr, s.y * dpr, s.r * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const s of stars.near) {
      const a = s.a * (0.7 + 0.3 * Math.sin(time * 0.0015 + s.twinkle));
      ctx.fillStyle = `rgba(180,210,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc((s.x + tNear) * dpr, s.y * dpr, s.r * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawAmbientGlow(width, height, camera) {
    if (!cachedLayout || cachedLayout.districts.length === 0) return;
    const b = cachedLayout.totalBounds;
    const cx = camera.project((b.maxWx - b.minWx) / 2, (b.maxWy - b.minWy) / 2).x;
    const cy = camera.project((b.maxWx - b.minWx) / 2, (b.maxWy - b.minWy) / 2).y;
    const r = Math.max(width, height) * 0.55;
    const grad = ctx.createRadialGradient(cx, cy + r * 0.1, 0, cx, cy + r * 0.1, r);
    grad.addColorStop(0, 'rgba(70,110,200,0.18)');
    grad.addColorStop(0.5, 'rgba(40,60,130,0.06)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  function projectGhostCells(data, layout) {
    const districts = layout.districts;
    if (districts.length === 0) return [];

    // Both completed buildings and in-progress placements reserve a cell.
    const reserved = data.tasks.filter(t =>
      (t.status === 'complete' || t.status === 'in_progress') && t.building && t.building.cell
    );
    const occupiedByDistrict = new Map();
    for (const ld of districts) {
      const set = new Set();
      for (const t of reserved) {
        if (t.districtId !== ld.id) continue;
        const c = t.building.cell;
        if (typeof c.col === 'number' && typeof c.row === 'number') {
          set.add(c.col + ',' + c.row);
        }
      }
      occupiedByDistrict.set(ld.id, set);
    }

    const ghosts = [];
    const pending = [...data.tasks]
      .filter(t => t.status === 'pending')
      .sort((a, b) => {
        const pa = a.priority || a.createdAt || '';
        const pb = b.priority || b.createdAt || '';
        return pa.localeCompare(pb);
      });

    for (const task of pending) {
      const layoutD = districts.find(d => d.id === task.districtId);
      if (!layoutD) continue;
      const occ = occupiedByDistrict.get(layoutD.id);
      const size = layoutD.size;
      let found = null;
      for (let r = 0; r < size && !found; r++) {
        for (let c = 0; c < size && !found; c++) {
          if (!occ.has(c + ',' + r)) {
            found = { col: c, row: r };
          }
        }
      }
      if (!found) continue; // overflow ghost - skip rather than misplace
      occ.add(found.col + ',' + found.row);
      const world = cellToWorld(layoutD, found.col, found.row);
      ghosts.push({ taskId: task.id, world, color: layoutD.color });
    }
    return ghosts;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function animateRise(buildingData, color) {
    const id = buildingData.seed + '-' + Math.random();
    const total = buildingData.windowCols * buildingData.windowRows;
    const winStart = 600;
    const stagger = 20;
    const winDur = 200;
    const baseFlashDur = 400;
    const totalDur = winStart + total * stagger + winDur + 100;

    animations.set(id, {
      taskId: id,
      building: buildingData,
      color,
      startTime: performance.now(),
      totalDur,
      winStart,
      stagger,
      winDur,
      baseFlashDur
    });

    const camera = getCamera(0, 0);
    if (camera && buildingData.cell) {
      const c = camera.project(buildingData.cell.wx + 0.5, buildingData.cell.wy + 0.5, 0);
      particles.push({
        kind: 'plus',
        x: c.x,
        y: c.y - 80 * dpr,
        startTime: performance.now() + 600,
        life: 800,
        color
      });
      celebrate(buildingData.cell, color);
    }

    scheduleTick();
  }

  function animateConstructionStart(buildingData, color) {
    if (!buildingData || !buildingData.cell) return;
    const camera = getCamera(0, 0);
    if (!camera) { scheduleTick(); return; }

    const cell = buildingData.cell;
    const center = camera.project(cell.wx + 0.5, cell.wy + 0.5, 0);

    if (!reduced()) {
      // A short, low-key flare under the cell so the user can see exactly
      // where the new construction landed without the full completion show.
      beams.push({
        x: center.x,
        y: center.y,
        startTime: performance.now(),
        life: 380,
        color
      });

      const sparkCount = 4;
      for (let i = 0; i < sparkCount; i++) {
        const ang = -Math.PI / 2 + (i - sparkCount / 2) * 0.7 + (Math.random() - 0.5) * 0.4;
        const speed = (2 + Math.random() * 1.5) * dpr;
        sparks.push({
          x: center.x,
          y: center.y - 6 * dpr,
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed - 1.2 * dpr,
          startTime: performance.now(),
          life: 480,
          color
        });
      }
    }

    scheduleTick();
  }

  function celebrate(cell, color) {
    if (reduced()) return;
    const camera = getCamera(0, 0);
    if (!camera) return;

    flashVignette(color);

    const center = camera.project(cell.wx + 0.5, cell.wy + 0.5, 0);

    beams.push({
      x: center.x,
      y: center.y,
      startTime: performance.now(),
      life: 700,
      color
    });

    const sparkCount = 6;
    for (let i = 0; i < sparkCount; i++) {
      const ang = -Math.PI / 2 + (i - sparkCount / 2) * 0.5 + (Math.random() - 0.5) * 0.3;
      const speed = (3 + Math.random() * 2) * dpr;
      sparks.push({
        x: center.x,
        y: center.y - 8 * dpr,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed - 2 * dpr,
        startTime: performance.now(),
        life: 600,
        color
      });
    }

    const fromY = cssH * 0.85 * dpr;
    const fromX = cssW * 0.5 * dpr;
    traces.push({
      fromX,
      fromY,
      toX: center.x,
      toY: center.y,
      startTime: performance.now(),
      life: 350,
      color
    });

    const off = camera.project(cell.wx + 0.5, cell.wy + 0.5, 0);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dx = (off.x - cx) * 0.05;
    const dy = (off.y - cy) * 0.05;
    punchSpring.setValue(0);
    punchTarget.x = dx;
    punchTarget.y = dy;
    punchSpring.set(1);
    setTimeout(() => { punchSpring.set(0); }, 90);
  }

  function flashVignette(color) {
    const el = document.getElementById('vignette');
    if (!el) return;
    el.style.setProperty('--vignette-color', hexToRgba(color, 0.55));
    el.classList.remove('is-flashing');
    void el.offsetWidth;
    el.classList.add('is-flashing');
    setTimeout(() => el.classList.remove('is-flashing'), 600);
  }

  function highlightCell(world, color) {
    if (!world) return;
    highlights.length = 0;
    highlights.push({
      world,
      color: color || '#00f5ff',
      startTime: performance.now(),
      life: 9999999
    });
    scheduleTick();
  }

  function clearHighlight() {
    highlights.length = 0;
  }

  function scheduleTick() {
    if (rafHandle) return;
    rafHandle = requestAnimationFrame(tick);
  }

  function tick(time) {
    rafHandle = null;
    drawFrame(time);
  }

  const punchTarget = { x: 0, y: 0 };

  function getCameraOffsets(time) {
    let sway = { x: 0, y: 0 };
    if (!reduced()) {
      sway.x = Math.sin((time - mountTime) / 3000) * 4 * dpr;
      sway.y = Math.cos((time - mountTime) / 3700) * 2 * dpr;
    }
    let punch = { x: 0, y: 0 };
    if (!reduced()) {
      const v = punchSpring.value;
      punch.x = punchTarget.x * v;
      punch.y = punchTarget.y * v;
    }
    return {
      offX: sway.x + punch.x,
      offY: sway.y + punch.y,
      sway,
      punch
    };
  }

  function drawFrame(time) {
    if (!lastData) return;

    const dt = Math.min(64, time - lastFrameT);
    lastFrameT = time;
    if (!punchSpring.isAtRest()) punchSpring.tick(dt);

    if (!tileHSpring.isAtRest()) tileHSpring.tick(dt);
    if (!originXSpring.isAtRest()) originXSpring.tick(dt);
    if (!originYSpring.isAtRest()) originYSpring.tick(dt);

    const width = canvas.width;
    const height = canvas.height;

    const offsets = getCameraOffsets(time);

    if (!cachedLayout) refreshLayout(lastData);
    // If the spring never received an initial value (e.g. first frame before
    // applyCameraTargets could measure the canvas), snap it now so we don't
    // silently skip the very first draw.
    if (tileHSpring.value === 0 && !cameraInited) applyCameraTargets({ snap: true });
    const camera = getCamera(offsets.offX, offsets.offY);
    if (!camera) return;

    ctx.clearRect(0, 0, width, height);
    drawSky(width, height);
    drawStars(width, height, lastData.meta && lastData.meta.installSeed ? lastData.meta.installSeed : 12345, time, offsets);

    drawAmbientGlow(width, height, camera);

    const layout = cachedLayout;
    const districtMap = new Map(layout.districts.map(d => [d.id, d]));

    for (const ld of layout.districts) {
      drawIsoFloor(ctx, ld, camera.project, ld.color, dpr);
    }
    for (const ld of layout.districts) {
      drawIsoFloorLabel(ctx, ld, camera.project, ld.color, dpr);
    }

    const ghosts = projectGhostCells(lastData, layout);
    const sortedGhosts = ghosts
      .slice()
      .sort((a, b) => (a.world.wx + a.world.wy) - (b.world.wx + b.world.wy));
    for (const g of sortedGhosts) {
      drawIsoGhost(ctx, camera.project, g.world, g.color, dpr);
    }

    for (const h of highlights) {
      drawHighlight(ctx, camera.project, h, time, dpr);
    }

    const animatingSeeds = new Set();
    for (const a of animations.values()) animatingSeeds.add(a.building.seed);

    const drawables = [];
    for (const t of lastData.tasks) {
      if (!t.building || !t.building.cell) continue;
      const ld = districtMap.get(t.districtId);
      if (!ld) continue;
      const cell = t.building.cell;
      if (t.status === 'complete') {
        if (animatingSeeds.has(t.building.seed)) continue;
        drawables.push({
          kind: 'building',
          building: t.building,
          color: ld.color,
          sortKey: cell.wx + cell.wy + (t.building.height / 1000)
        });
      } else if (t.status === 'in_progress') {
        drawables.push({
          kind: 'construction',
          building: t.building,
          color: ld.color,
          // Sort against neighbour cells but slightly behind a finished
          // building in the same cell (impossible in practice, but safe).
          sortKey: cell.wx + cell.wy + 0.0005
        });
      }
    }

    drawables.sort((a, b) => a.sortKey - b.sortKey);

    for (const d of drawables) {
      if (d.kind === 'construction') {
        drawIsoBaseGlow(ctx, camera.project, d.building.cell, d.color, 0.08, dpr);
        drawIsoFoundation(ctx, camera.project, d.building.cell, d.color, dpr);
        drawIsoWireframe(ctx, d.building, d.color, camera.project, camera.elevScale, dpr, time);
        drawIsoCrane(ctx, d.building, d.color, camera.project, camera.elevScale, dpr, time);
      } else {
        drawIsoBaseGlow(ctx, camera.project, d.building.cell, d.color, 0.05, dpr);
        drawIsoBuilding(ctx, d.building, d.color, {
          project: camera.project,
          elevScale: camera.elevScale,
          dpr,
          riseProgress: 1,
          time
        });
      }
    }

    const animList = [...animations.values()].sort((a, b) => {
      const ca = a.building.cell, cb = b.building.cell;
      return (ca.wx + ca.wy) - (cb.wx + cb.wy);
    });

    for (const anim of animList) {
      const elapsed = time - anim.startTime;
      const riseT = Math.max(0, Math.min(1, elapsed / 600));
      const riseProgress = easeOutCubic(riseT);

      const total = anim.building.windowCols * anim.building.windowRows;
      const windowProgress = new Array(total);
      for (let i = 0; i < total; i++) {
        const winStartAt = anim.winStart + i * anim.stagger;
        const wt = (elapsed - winStartAt) / anim.winDur;
        windowProgress[i] = Math.max(0, Math.min(1, wt));
      }

      const flashElapsed = elapsed;
      let flashAlpha = 0.06;
      if (flashElapsed >= 0 && flashElapsed <= anim.baseFlashDur) {
        const ft = flashElapsed / anim.baseFlashDur;
        flashAlpha = ft < 0.5 ? ft * 1.2 : (1 - ft) * 1.2;
        flashAlpha = Math.max(0.06, Math.min(0.6, flashAlpha));
      }
      drawIsoBaseGlow(ctx, camera.project, anim.building.cell, anim.color, flashAlpha, dpr);

      drawIsoBuilding(ctx, anim.building, anim.color, {
        project: camera.project,
        elevScale: camera.elevScale,
        dpr,
        riseProgress,
        windowProgress,
        time
      });

      if (elapsed > anim.totalDur) {
        animations.delete(anim.taskId);
      }
    }

    drawBeams(ctx, time);
    drawSparks(ctx, time, dt);
    drawTraces(ctx, time);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const elapsed = time - p.startTime;
      if (elapsed < 0) continue;
      if (elapsed > p.life) {
        particles.splice(i, 1);
        continue;
      }
      const t = elapsed / p.life;
      const alpha = 1 - t;
      const dy = -40 * dpr * t;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `${12 * dpr}px JetBrains Mono, monospace`;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6 * dpr;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('+1', p.x, p.y + dy);
      ctx.restore();
    }

    if (
      animations.size > 0 ||
      particles.length > 0 ||
      sparks.length > 0 ||
      beams.length > 0 ||
      traces.length > 0 ||
      highlights.length > 0 ||
      hasFlickerWindows() ||
      !punchSpring.isAtRest() ||
      !tileHSpring.isAtRest() ||
      !originXSpring.isAtRest() ||
      !originYSpring.isAtRest() ||
      !reduced()
    ) {
      scheduleTick();
    }
  }

  function drawBeams(ctx, time) {
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i];
      const e = time - b.startTime;
      if (e > b.life) { beams.splice(i, 1); continue; }
      const t = e / b.life;
      const alpha = (1 - t) * 0.85;
      const w = 6 * dpr * (1 - t * 0.5);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const grad = ctx.createLinearGradient(b.x, 0, b.x, b.y);
      grad.addColorStop(0, hexToRgba(b.color, 0));
      grad.addColorStop(0.4, hexToRgba(b.color, alpha * 0.4));
      grad.addColorStop(1, hexToRgba(b.color, alpha));
      ctx.fillStyle = grad;
      ctx.fillRect(b.x - w / 2, 0, w, b.y);
      ctx.restore();
    }
  }

  function drawSparks(ctx, time, dt) {
    const dts = dt / 16.67;
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      const e = time - s.startTime;
      if (e > s.life) { sparks.splice(i, 1); continue; }
      s.x += s.vx * dts;
      s.y += s.vy * dts;
      s.vy += 0.18 * dpr * dts;
      s.vx *= 0.985;
      const t = e / s.life;
      const alpha = 1 - t;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 8 * dpr;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2 * dpr * (1 - t * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawTraces(ctx, time) {
    for (let i = traces.length - 1; i >= 0; i--) {
      const tr = traces[i];
      const e = time - tr.startTime;
      if (e > tr.life) { traces.splice(i, 1); continue; }
      const t = e / tr.life;
      const alpha = (1 - t);
      const px = tr.fromX + (tr.toX - tr.fromX) * Math.min(1, t * 1.4);
      const py = tr.fromY + (tr.toY - tr.fromY) * Math.min(1, t * 1.4);
      ctx.save();
      ctx.strokeStyle = hexToRgba(tr.color, alpha * 0.7);
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(tr.fromX, tr.fromY);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawHighlight(ctx, project, h, time, dpr) {
    const t = ((time - h.startTime) % 1400) / 1400;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    const alpha = 0.35 + 0.45 * pulse;
    const c0 = project(h.world.wx, h.world.wy, 0);
    const c1 = project(h.world.wx + 1, h.world.wy, 0);
    const c2 = project(h.world.wx + 1, h.world.wy + 1, 0);
    const c3 = project(h.world.wx, h.world.wy + 1, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hexToRgba(h.color, alpha);
    ctx.lineWidth = 2 * dpr;
    ctx.shadowColor = h.color;
    ctx.shadowBlur = 12 * dpr;
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c3.x, c3.y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function hasFlickerWindows() {
    if (!lastData) return false;
    for (const t of lastData.tasks) {
      if (t.status === 'complete' && t.building && t.building.flickerWindows && t.building.flickerWindows.length > 0) {
        return true;
      }
    }
    return false;
  }

  function nextCell(districtId) {
    if (!lastData || !cachedLayout) return null;
    const ld = cachedLayout.districts.find(d => d.id === districtId);
    if (!ld) return null;
    // Both completed and in-progress tasks hold a cell.
    const reserved = lastData.tasks.filter(t =>
      (t.status === 'complete' || t.status === 'in_progress') && t.building && t.building.cell
    );
    const cell = nextCellForDistrict(ld, reserved);
    if (!cell) {
      // Overflow: place at (size-1, size-1) so the building still appears.
      const col = ld.size - 1;
      const row = ld.size - 1;
      const world = cellToWorld(ld, col, row);
      return { world, overflowed: true };
    }
    const world = cellToWorld(ld, cell.col, cell.row);
    return { world, overflowed: false };
  }

  function generateBuildingForTask(task) {
    const seed = seedFromString(task.id);
    return generateBuilding({ seed });
  }

  function ghostCellForTask(taskId) {
    if (!lastData || !cachedLayout) return null;
    const ghosts = projectGhostCells(lastData, cachedLayout);
    const found = ghosts.find(g => g.taskId === taskId);
    if (!found) return null;
    return { world: found.world, color: found.color };
  }

  scheduleTick();

  return {
    render,
    animateRise,
    animateConstructionStart,
    getDimensions,
    on,
    nextCell,
    getLayout,
    generateBuildingForTask,
    highlightCell,
    clearHighlight,
    ghostCellForTask,
    setFocus,
    resetCamera,
    isManual,
    refreshCamera: () => applyCameraTargets({ snap: false }),
    toast: (msg, opts) => showToast(msg, opts)
  };
}

function hashDistricts(districts) {
  if (!districts || districts.length === 0) return '';
  return districts
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(d => `${d.id}:${d.order}:${d.color}`)
    .join('|');
}
