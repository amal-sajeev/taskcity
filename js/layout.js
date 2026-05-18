export const INITIAL_SIZE = 3;
export const STRIP_GAP = 2;

export function computeCityLayout(rawDistricts) {
  const districts = [...(rawDistricts || [])].sort((a, b) => a.order - b.order);
  const n = districts.length;
  if (n === 0) {
    return {
      mode: 'strip',
      districts: [],
      totalBounds: { minWx: 0, maxWx: 0, minWy: 0, maxWy: 0 }
    };
  }

  const out = [];
  let cursorX = 0;
  let maxRows = 0;
  for (const d of districts) {
    const size = Math.max(INITIAL_SIZE, Number(d.size) || INITIAL_SIZE);
    const originCell = { wx: cursorX, wy: 0 };
    out.push({
      id: d.id,
      name: d.name,
      color: d.color,
      size,
      cols: size,
      rows: size,
      originCell,
      bounds: {
        minWx: originCell.wx,
        maxWx: originCell.wx + size,
        minWy: originCell.wy,
        maxWy: originCell.wy + size
      }
    });
    cursorX += size + STRIP_GAP;
    if (size > maxRows) maxRows = size;
  }

  const totalCols = cursorX - STRIP_GAP;
  return {
    mode: 'strip',
    districts: out,
    totalBounds: {
      minWx: 0,
      maxWx: Math.max(0, totalCols),
      minWy: 0,
      maxWy: maxRows
    }
  };
}

export function cellToWorld(layoutDistrict, col, row) {
  return {
    wx: layoutDistrict.originCell.wx + col,
    wy: layoutDistrict.originCell.wy + row,
    col,
    row
  };
}

export function worldFromCellRC(layoutDistrict, col, row) {
  return {
    wx: layoutDistrict.originCell.wx + col,
    wy: layoutDistrict.originCell.wy + row
  };
}

export function nextCellForDistrict(layoutDistrict, completedTasks) {
  const occupied = new Set();
  for (const t of completedTasks) {
    if (t.districtId !== layoutDistrict.id) continue;
    const c = t.building && t.building.cell;
    if (!c) continue;
    if (typeof c.col === 'number' && typeof c.row === 'number') {
      occupied.add(c.col + ',' + c.row);
    }
  }
  const size = layoutDistrict.size;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!occupied.has(c + ',' + r)) {
        return { col: c, row: r };
      }
    }
  }
  return null;
}

export function makeProjector({ tileW, tileH, originX, originY, elevScale }) {
  return function project(wx, wy, wz = 0) {
    return {
      x: originX + (wx - wy) * (tileW / 2),
      y: originY + (wx + wy) * (tileH / 2) - wz * elevScale
    };
  };
}

const ELEV_RATIO = 1.6;
const MAX_BUILDING_WZ = 3.0;

export function computeCameraFit({ layout, cssW, cssH, padX = 0.92, padY = 0.92, topInset = 56, bottomInset = 0 }) {
  return computeCameraFitForBounds({
    bounds: layout.totalBounds,
    cssW,
    cssH,
    padX,
    padY,
    topInset,
    bottomInset
  });
}

export function computeCameraFitFocused({ layout, focusedId, cssW, cssH, padX = 0.92, padY = 0.92, topInset = 56, bottomInset = 0 }) {
  if (!focusedId) {
    return computeCameraFit({ layout, cssW, cssH, padX, padY, topInset, bottomInset });
  }
  const focused = layout.districts.find(d => d.id === focusedId);
  if (!focused) {
    return computeCameraFit({ layout, cssW, cssH, padX, padY, topInset, bottomInset });
  }
  const i = layout.districts.indexOf(focused);
  const left = i > 0 ? layout.districts[i - 1] : null;
  const right = i < layout.districts.length - 1 ? layout.districts[i + 1] : null;

  let minWx = focused.bounds.minWx;
  let maxWx = focused.bounds.maxWx;
  let minWy = focused.bounds.minWy;
  let maxWy = focused.bounds.maxWy;

  if (left) {
    const leftWidth = left.bounds.maxWx - left.bounds.minWx;
    minWx -= leftWidth * 0.5 + STRIP_GAP;
    minWy = Math.min(minWy, left.bounds.minWy);
    maxWy = Math.max(maxWy, left.bounds.maxWy);
  }
  if (right) {
    const rightWidth = right.bounds.maxWx - right.bounds.minWx;
    maxWx += rightWidth * 0.5 + STRIP_GAP;
    minWy = Math.min(minWy, right.bounds.minWy);
    maxWy = Math.max(maxWy, right.bounds.maxWy);
  }
  // Clamp to actual city
  minWx = Math.max(layout.totalBounds.minWx, minWx);
  maxWx = Math.min(layout.totalBounds.maxWx, maxWx);

  return computeCameraFitForBounds({
    bounds: { minWx, maxWx, minWy, maxWy },
    cssW,
    cssH,
    padX,
    padY,
    topInset,
    bottomInset
  });
}

export function computeCameraFitForBounds({ bounds, cssW, cssH, padX = 0.92, padY = 0.92, topInset = 56, bottomInset = 0 }) {
  const minWx = bounds.minWx || 0;
  const minWy = bounds.minWy || 0;
  const localW = Math.max(1, bounds.maxWx - minWx);
  const localH = Math.max(1, bounds.maxWy - minWy);

  const visibleH = Math.max(120, cssH - topInset - bottomInset);
  const visibleW = Math.max(120, cssW);

  const projWidth = localW + localH;
  const projHeight = (localW + localH) / 2;

  const elevHeadroomTiles = MAX_BUILDING_WZ * ELEV_RATIO;
  const projHeightWithElev = projHeight + elevHeadroomTiles;

  const tileWByW = (visibleW * padX) / projWidth;
  const tileHByH = (visibleH * padY) / projHeightWithElev;

  let tileH = Math.min(tileHByH, tileWByW / 2);
  tileH = Math.max(7, Math.min(tileH, 60));
  const tileW = tileH * 2;

  const elevScale = tileH * ELEV_RATIO;
  const buildingExtUp = MAX_BUILDING_WZ * elevScale;

  const cityScreenW = projWidth * (tileW / 2);
  const cityScreenH = projHeight * tileH;
  const totalScreenH = cityScreenH + buildingExtUp;

  // Center the focused bounds within the visible band.
  // The screen-space leftmost point of the bounds (before originX) is at:
  //   (minWx - maxWy) * (tileW/2)
  // The screen-space topmost point (before originY) is at:
  //   (minWx + minWy) * (tileH/2)
  // We want the bounds centered horizontally and within the visible band vertically.
  const boundsScreenLeft = (minWx - bounds.maxWy) * (tileW / 2);
  const originX = (cssW - cityScreenW) / 2 - boundsScreenLeft;

  const boundsScreenTop = (minWx + minWy) * (tileH / 2);
  const visibleTop = topInset;
  const visibleBottom = cssH - bottomInset;
  const visibleCenter = (visibleTop + visibleBottom) / 2;
  const originY = visibleCenter - totalScreenH / 2 + buildingExtUp - boundsScreenTop;

  return { tileW, tileH, originX, originY, elevScale };
}
