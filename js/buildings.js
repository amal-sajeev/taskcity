export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rand(rng, min, max) {
  return min + rng() * (max - min);
}

function randInt(rng, min, max) {
  return Math.floor(rand(rng, min, max + 1));
}

function weightedHeight(rng, min, max) {
  const r = Math.pow(rng(), 1.7);
  return min + r * (max - min);
}

const HEIGHT_MIN = 70;
const HEIGHT_MAX = 220;

export function generateBuilding({ seed }) {
  const rng = mulberry32(seed);

  const width = Math.round(rand(rng, 28, 58));
  const height = Math.round(weightedHeight(rng, HEIGHT_MIN, HEIGHT_MAX));

  const windowCols = width < 34 ? 2 : (width > 48 ? 4 : 3);
  const windowRows = Math.max(4, Math.min(12, Math.round(height / 18)));
  const total = windowCols * windowRows;
  const litFraction = rand(rng, 0.6, 0.9);
  const windowLit = new Array(total);
  for (let i = 0; i < total; i++) windowLit[i] = rng() < litFraction;

  const r = rng();
  let roofStyle;
  if (r < 0.6) roofStyle = 'flat';
  else if (r < 0.9) roofStyle = 'stepped';
  else roofStyle = 'antenna';
  const antennae = roofStyle === 'antenna';

  const flickerCount = randInt(rng, 0, Math.min(2, total));
  const flickerWindows = [];
  for (let i = 0; i < flickerCount; i++) {
    flickerWindows.push(randInt(rng, 0, total - 1));
  }

  return {
    seed,
    width,
    height,
    windowCols,
    windowRows,
    windowLit,
    roofStyle,
    antennae,
    flickerWindows,
    cell: null
  };
}

export function buildingHeightUnits(b, elevScale) {
  const ratio = (b.height - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN);
  return (0.6 + ratio * 2.4) * elevScale;
}

export function hexToRgba(hex, alpha = 1) {
  let h = String(hex || '#00f5ff').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function fillQuad(ctx, p0, p1, p2, p3, fillStyle, strokeStyle, lineWidth) {
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();
  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth || 1;
    ctx.stroke();
  }
}

export function drawIsoFloor(ctx, layoutDistrict, project, color, dpr) {
  const { wx, wy } = layoutDistrict.originCell;
  const cols = layoutDistrict.cols;
  const rows = layoutDistrict.rows;

  const p0 = project(wx, wy);
  const p1 = project(wx + cols, wy);
  const p2 = project(wx + cols, wy + rows);
  const p3 = project(wx, wy + rows);

  fillQuad(ctx, p0, p1, p2, p3, hexToRgba(color, 0.05), hexToRgba(color, 0.28), 1 * dpr);

  ctx.save();
  ctx.strokeStyle = hexToRgba(color, 0.10);
  ctx.lineWidth = 1 * dpr;
  for (let c = 1; c < cols; c++) {
    const a = project(wx + c, wy);
    const b = project(wx + c, wy + rows);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (let r = 1; r < rows; r++) {
    const a = project(wx, wy + r);
    const b = project(wx + cols, wy + r);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawIsoFloorLabel(ctx, layoutDistrict, project, color, dpr) {
  const { wx, wy } = layoutDistrict.originCell;
  const cols = layoutDistrict.cols;
  const rows = layoutDistrict.rows;
  const center = project(wx + cols / 2, wy + rows + 0.05);

  ctx.save();
  ctx.font = `${10 * dpr}px Orbitron, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = hexToRgba(color, 0.55);
  ctx.fillText(layoutDistrict.name.toUpperCase(), center.x, center.y);
  ctx.restore();
}

export function drawIsoGhost(ctx, project, world, color, dpr) {
  const { wx, wy } = world;
  const inset = 0.12;
  const x0 = wx + inset;
  const x1 = wx + 1 - inset;
  const y0 = wy + inset;
  const y1 = wy + 1 - inset;

  const p0 = project(x0, y0);
  const p1 = project(x1, y0);
  const p2 = project(x1, y1);
  const p3 = project(x0, y1);

  ctx.save();
  ctx.strokeStyle = hexToRgba(color, 0.45);
  ctx.lineWidth = 1 * dpr;
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

export function drawIsoBaseGlow(ctx, project, world, color, alpha, dpr) {
  const { wx, wy } = world;
  const c = project(wx + 0.5, wy + 0.5);
  const r = 60 * dpr;
  const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
  grad.addColorStop(0, hexToRgba(color, alpha));
  grad.addColorStop(1, hexToRgba(color, 0));
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
  ctx.restore();
}

export function drawIsoBuilding(ctx, b, color, opts) {
  const {
    project,
    elevScale,
    dpr = 1,
    riseProgress = 1,
    windowProgress = null,
    time = 0
  } = opts;

  if (!b.cell) return;

  const { wx, wy } = b.cell;
  const inset = 0.1;
  const x0 = wx + inset;
  const x1 = wx + 1 - inset;
  const y0 = wy + inset;
  const y1 = wy + 1 - inset;

  const heightUnits = buildingHeightUnits(b, elevScale);
  const wz = (heightUnits / elevScale) * riseProgress;

  const baseNW = project(x0, y0, 0);
  const baseNE = project(x1, y0, 0);
  const baseSE = project(x1, y1, 0);
  const baseSW = project(x0, y1, 0);

  const topNW = project(x0, y0, wz);
  const topNE = project(x1, y0, wz);
  const topSE = project(x1, y1, wz);
  const topSW = project(x0, y1, wz);

  const eastFill = hexToRgba(color, 0.22);
  const eastStroke = hexToRgba(color, 0.55);
  const southFill = hexToRgba(color, 0.42);
  const southStroke = hexToRgba(color, 0.7);
  const topFill = hexToRgba(color, 0.6);
  const topStroke = hexToRgba(color, 0.9);

  fillQuad(ctx, baseNE, topNE, topSE, baseSE, eastFill, eastStroke, 0.75 * dpr);
  drawFaceWindows(ctx, b, topSE, baseSE, topNE, baseNE, dpr, windowProgress, time, 'east');

  fillQuad(ctx, baseSW, topSW, topSE, baseSE, southFill, southStroke, 0.75 * dpr);
  drawFaceWindows(ctx, b, topSW, baseSW, topSE, baseSE, dpr, windowProgress, time, 'south');

  fillQuad(ctx, topNW, topNE, topSE, topSW, topFill, topStroke, 0.75 * dpr);

  drawIsoRoof(ctx, b, color, project, x0, y0, x1, y1, wz, elevScale, dpr);
}

function drawFaceWindows(ctx, b, topL, botL, topR, botR, dpr, windowProgress, time, faceKey) {
  const cols = b.windowCols;
  const rows = b.windowRows;
  if (cols <= 0 || rows <= 0) return;

  const padU = 0.18;
  const padV = 0.10;
  const winSizeU = (1 - padU * 2) / cols;
  const winSizeV = (1 - padV * 2) / rows;
  const spacing = 0.35;
  const innerU = winSizeU * (1 - spacing);
  const innerV = winSizeV * (1 - spacing);

  const litColor = '#fff8c0';
  const dimColor = 'rgba(255,240,180,0.10)';

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const litIdx = faceKey === 'east' ? r * cols + (cols - 1 - c) : idx;
      const isLit = b.windowLit[litIdx];

      let alpha = 1;
      if (windowProgress) {
        const p = windowProgress[idx];
        if (p === undefined) continue;
        alpha = Math.max(0, Math.min(1, p));
      }

      let lit = isLit;
      if (b.flickerWindows && b.flickerWindows.includes(litIdx)) {
        const flick = (Math.sin(time * 0.003 + litIdx * 13.13) + 1) * 0.5;
        if (flick < 0.18) lit = false;
      }

      const u0 = padU + c * winSizeU + (winSizeU - innerU) / 2;
      const v0 = padV + r * winSizeV + (winSizeV - innerV) / 2;
      const u1 = u0 + innerU;
      const v1 = v0 + innerV;

      const p00 = uvToScreen(topL, botL, topR, botR, u0, v0);
      const p10 = uvToScreen(topL, botL, topR, botR, u1, v0);
      const p11 = uvToScreen(topL, botL, topR, botR, u1, v1);
      const p01 = uvToScreen(topL, botL, topR, botR, u0, v1);

      ctx.save();
      ctx.globalAlpha = alpha;
      if (lit) {
        ctx.shadowColor = '#ffe080';
        ctx.shadowBlur = 3 * dpr;
        ctx.fillStyle = litColor;
      } else {
        ctx.fillStyle = dimColor;
      }
      ctx.beginPath();
      ctx.moveTo(p00.x, p00.y);
      ctx.lineTo(p10.x, p10.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.lineTo(p01.x, p01.y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}

function uvToScreen(topL, botL, topR, botR, u, v) {
  const left = lerpPoint(topL, botL, v);
  const right = lerpPoint(topR, botR, v);
  return lerpPoint(left, right, u);
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// ── Under-construction primitives ──────────────────────────────────────────

export const FOUNDATION_WZ = 0.08;

function strokeSegment(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

export function drawIsoFoundation(ctx, project, world, color, dpr) {
  const { wx, wy } = world;
  const inset = 0.06;
  const x0 = wx + inset;
  const x1 = wx + 1 - inset;
  const y0 = wy + inset;
  const y1 = wy + 1 - inset;
  const wz = FOUNDATION_WZ;

  const baseNE = project(x1, y0, 0);
  const baseSE = project(x1, y1, 0);
  const baseSW = project(x0, y1, 0);
  const topNW = project(x0, y0, wz);
  const topNE = project(x1, y0, wz);
  const topSE = project(x1, y1, wz);
  const topSW = project(x0, y1, wz);

  // Concrete-look fills with the district color as a faint edge accent.
  const concreteEast  = 'rgba(50,55,68,0.65)';
  const concreteSouth = 'rgba(40,45,58,0.78)';
  const concreteTop   = 'rgba(70,78,92,0.85)';
  const edge = hexToRgba(color, 0.5);

  fillQuad(ctx, baseNE, topNE, topSE, baseSE, concreteEast,  edge, 0.6 * dpr);
  fillQuad(ctx, baseSW, topSW, topSE, baseSE, concreteSouth, edge, 0.6 * dpr);
  fillQuad(ctx, topNW,  topNE, topSE, topSW, concreteTop,   edge, 0.6 * dpr);
}

export function drawIsoWireframe(ctx, b, color, project, elevScale, dpr, time) {
  if (!b.cell) return;
  const { wx, wy } = b.cell;
  const inset = 0.1;
  const x0 = wx + inset;
  const x1 = wx + 1 - inset;
  const y0 = wy + inset;
  const y1 = wy + 1 - inset;
  const heightUnits = buildingHeightUnits(b, elevScale);
  const wzTop = heightUnits / elevScale;
  const wzBase = FOUNDATION_WZ;

  const baseNW = project(x0, y0, wzBase);
  const baseNE = project(x1, y0, wzBase);
  const baseSE = project(x1, y1, wzBase);
  const baseSW = project(x0, y1, wzBase);
  const topNW = project(x0, y0, wzTop);
  const topNE = project(x1, y0, wzTop);
  const topSE = project(x1, y1, wzTop);
  const topSW = project(x0, y1, wzTop);

  // Slow breathing pulse so the silhouette feels alive even when static.
  const pulse = 0.55 + 0.30 * (0.5 + 0.5 * Math.sin(time * 0.002 + b.seed * 0.0001));

  ctx.save();
  ctx.strokeStyle = hexToRgba(color, pulse);
  ctx.lineWidth = 1 * dpr;
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  ctx.shadowColor = color;
  ctx.shadowBlur = 4 * dpr;

  // 4 verticals
  strokeSegment(ctx, baseNW, topNW);
  strokeSegment(ctx, baseNE, topNE);
  strokeSegment(ctx, baseSE, topSE);
  strokeSegment(ctx, baseSW, topSW);
  // 4 top edges
  strokeSegment(ctx, topNW, topNE);
  strokeSegment(ctx, topNE, topSE);
  strokeSegment(ctx, topSE, topSW);
  strokeSegment(ctx, topSW, topNW);
  // 4 base edges (faded so they don't fight the foundation top)
  ctx.globalAlpha = 0.55;
  strokeSegment(ctx, baseNW, baseNE);
  strokeSegment(ctx, baseNE, baseSE);
  strokeSegment(ctx, baseSE, baseSW);
  strokeSegment(ctx, baseSW, baseNW);
  ctx.restore();
}

export function drawIsoCrane(ctx, b, color, project, elevScale, dpr, time) {
  if (!b.cell) return;
  const { wx, wy } = b.cell;
  const cx = wx + 0.5;
  const cy = wy + 0.5;
  const wzBase = FOUNDATION_WZ;
  const heightUnits = buildingHeightUnits(b, elevScale);
  const buildingWz = heightUnits / elevScale;
  const mastTopWz = Math.max(1.2, buildingWz * 1.15);

  const mastBase = project(cx, cy, wzBase);
  const mastTop  = project(cx, cy, mastTopWz);

  // Deterministic starting angle from the seed, plus slow rotation around the
  // vertical axis (the jib stays horizontal so the isometric perspective is
  // preserved -- we only spin it within the XY ground plane in world space).
  const seedAng = ((b.seed >>> 0) % 360) * Math.PI / 180;
  const angVel = 0.62; // rad / sec  (~ 36 deg / sec)
  const ang = seedAng + (time * 0.001) * angVel;

  const jibLen = 0.42; // forward arm (cells)
  const cwLen  = 0.18; // counter-weight arm (cells)
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const jibTipWx = cx + dx * jibLen;
  const jibTipWy = cy + dy * jibLen;
  const cwWx = cx - dx * cwLen;
  const cwWy = cy - dy * cwLen;

  const jibTip = project(jibTipWx, jibTipWy, mastTopWz);
  const cwBack = project(cwWx, cwWy, mastTopWz);

  // Hook hangs halfway down the mast height.
  const hookWz = Math.max(wzBase + 0.05, mastTopWz * 0.55);
  const hookTop = project(jibTipWx, jibTipWy, mastTopWz);
  const hookBot = project(jibTipWx, jibTipWy, hookWz);

  ctx.save();
  ctx.strokeStyle = hexToRgba(color, 0.88);
  ctx.shadowColor = color;
  ctx.shadowBlur = 4 * dpr;

  // Mast (thick)
  ctx.lineWidth = 1.6 * dpr;
  strokeSegment(ctx, mastBase, mastTop);

  // Jib (forward + counter-weight arm in one stroke)
  ctx.lineWidth = 1.2 * dpr;
  strokeSegment(ctx, cwBack, jibTip);

  // Counter-weight block
  const cwSize = 2.5 * dpr;
  ctx.shadowBlur = 0;
  ctx.fillStyle = hexToRgba(color, 0.85);
  ctx.fillRect(cwBack.x - cwSize, cwBack.y - cwSize, cwSize * 2, cwSize * 2);

  // Cable + hook
  ctx.lineWidth = 0.8 * dpr;
  ctx.shadowBlur = 2 * dpr;
  strokeSegment(ctx, hookTop, hookBot);
  const hookSize = 2 * dpr;
  ctx.fillStyle = hexToRgba(color, 0.95);
  ctx.fillRect(hookBot.x - hookSize, hookBot.y - hookSize / 2, hookSize * 2, hookSize);

  ctx.restore();
}

// ───────────────────────────────────────────────────────────────────────────

function drawIsoRoof(ctx, b, color, project, x0, y0, x1, y1, wz, elevScale, dpr) {
  if (b.roofStyle === 'flat') return;

  if (b.roofStyle === 'stepped') {
    const steps = 2 + ((b.seed >>> 4) & 1);
    let curX0 = x0, curY0 = y0, curX1 = x1, curY1 = y1;
    let curZ = wz;
    for (let i = 0; i < steps; i++) {
      const shrink = 0.18;
      const cx = (curX0 + curX1) / 2;
      const cy = (curY0 + curY1) / 2;
      curX0 = cx - (cx - curX0) * (1 - shrink);
      curX1 = cx + (curX1 - cx) * (1 - shrink);
      curY0 = cy - (cy - curY0) * (1 - shrink);
      curY1 = cy + (curY1 - cy) * (1 - shrink);
      const stepH = (0.18 + i * 0.06);
      const baseZ = curZ;
      const topZ = curZ + stepH;
      curZ = topZ;

      const baseNW = project(curX0, curY0, baseZ);
      const baseNE = project(curX1, curY0, baseZ);
      const baseSE = project(curX1, curY1, baseZ);
      const baseSW = project(curX0, curY1, baseZ);
      const topNW = project(curX0, curY0, topZ);
      const topNE = project(curX1, curY0, topZ);
      const topSE = project(curX1, curY1, topZ);
      const topSW = project(curX0, curY1, topZ);

      fillQuad(ctx, baseNE, topNE, topSE, baseSE, hexToRgba(color, 0.25 + i * 0.04), hexToRgba(color, 0.55), 0.75 * dpr);
      fillQuad(ctx, baseSW, topSW, topSE, baseSE, hexToRgba(color, 0.45 + i * 0.04), hexToRgba(color, 0.7), 0.75 * dpr);
      fillQuad(ctx, topNW, topNE, topSE, topSW, hexToRgba(color, 0.65 + i * 0.04), hexToRgba(color, 0.9), 0.75 * dpr);
    }
  } else if (b.roofStyle === 'antenna' || b.antennae) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const baseAnt = project(cx, cy, wz);
    const antLen = 0.6 + ((b.seed >>> 8) & 0xff) / 255 * 0.6;
    const tipAnt = project(cx, cy, wz + antLen);

    ctx.save();
    ctx.strokeStyle = hexToRgba(color, 0.85);
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(baseAnt.x, baseAnt.y);
    ctx.lineTo(tipAnt.x, tipAnt.y);
    ctx.stroke();

    ctx.fillStyle = hexToRgba(color, 0.95);
    ctx.beginPath();
    const r = 3 * dpr;
    ctx.moveTo(tipAnt.x, tipAnt.y - r);
    ctx.lineTo(tipAnt.x + r, tipAnt.y);
    ctx.lineTo(tipAnt.x, tipAnt.y + r);
    ctx.lineTo(tipAnt.x - r, tipAnt.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
