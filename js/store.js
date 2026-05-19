// Note: layout.js is intentionally not imported here so that migration logic
// is self-contained against future layout changes.

const KEY = 'citylog_data';
const VERSION = 5;
const DEFAULT_SETTINGS = { sound: false, haptics: true, motion: 'auto', showCompletedInTasks: false };
export const INITIAL_DISTRICT_SIZE = 3;

const DEFAULT_DISTRICTS = [
  { name: 'Work', color: '#00f5ff' },
  { name: 'Personal', color: '#bf5fff' },
  { name: 'Health', color: '#39ff14' }
];

function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function emptyData() {
  return {
    version: VERSION,
    districts: [],
    tasks: [],
    meta: {
      installSeed: Math.floor(Math.random() * 0xffffffff),
      installedAt: nowIso(),
      cursors: {},
      events: [],
      settings: { ...DEFAULT_SETTINGS },
      activeTab: 'city'
    }
  };
}

function seedDefaults(data) {
  if (data.districts.length === 0) {
    DEFAULT_DISTRICTS.forEach((d, i) => {
      data.districts.push({
        id: uuid(),
        name: d.name,
        color: d.color,
        order: i,
        size: INITIAL_DISTRICT_SIZE,
        createdAt: nowIso()
      });
    });
  }
}

function migrate(data) {
  const fromVersion = Number(data.version) || 1;
  if (fromVersion >= VERSION) return false;

  if (fromVersion < 2) {
    // Original v1 isometric layout used a fixed 8x3 strip per district.
    const STRIP_COLS_V1 = 8;
    const STRIP_GAP_V1 = 1;
    const districtsByOrder = [...data.districts].sort((a, b) => a.order - b.order);
    const districtOriginX = new Map();
    districtsByOrder.forEach((d, i) => {
      districtOriginX.set(d.id, i * (STRIP_COLS_V1 + STRIP_GAP_V1));
    });
    const counters = {};
    const ordered = [...data.tasks].sort((a, b) => {
      const aT = a.completedAt || a.createdAt || '';
      const bT = b.completedAt || b.createdAt || '';
      return aT.localeCompare(bT);
    });
    for (const t of ordered) {
      if (t.status !== 'complete' || !t.building) continue;
      if (t.building.cell && typeof t.building.cell.wx === 'number') continue;
      const originX = districtOriginX.get(t.districtId);
      if (originX == null) continue;
      const idx = (counters[t.districtId] = (counters[t.districtId] || 0) + 1) - 1;
      const col = idx % STRIP_COLS_V1;
      const row = Math.floor(idx / STRIP_COLS_V1);
      t.building.cell = {
        wx: originX + col,
        wy: row,
        col,
        row
      };
    }
    if (data.meta) data.meta.cursors = {};
  }

  if (fromVersion < 3) {
    if (!data.meta) data.meta = {};
    if (!data.meta.settings) data.meta.settings = { ...DEFAULT_SETTINGS };
    else data.meta.settings = { ...DEFAULT_SETTINGS, ...data.meta.settings };
    for (const t of data.tasks) {
      if (t.status === 'pending' && (t.priority == null)) {
        t.priority = t.createdAt || nowIso();
      }
    }
  }

  if (fromVersion < 4) {
    if (!data.meta) data.meta = {};
    if (!data.meta.activeTab) data.meta.activeTab = 'city';
    const counts = new Map();
    const maxCells = new Map();
    for (const t of data.tasks) {
      counts.set(t.districtId, (counts.get(t.districtId) || 0) + 1);
      const c = t.building && t.building.cell;
      if (c && typeof c.col === 'number' && typeof c.row === 'number') {
        const cur = maxCells.get(t.districtId) || 0;
        const need = Math.max(c.col, c.row) + 1;
        if (need > cur) maxCells.set(t.districtId, need);
      }
    }
    for (const d of data.districts) {
      if (typeof d.size !== 'number' || d.size < INITIAL_DISTRICT_SIZE) {
        const n = counts.get(d.id) || 0;
        const fromCount = Math.ceil(Math.sqrt(Math.max(1, n)));
        const fromCells = maxCells.get(d.id) || 0;
        d.size = Math.max(INITIAL_DISTRICT_SIZE, fromCount, fromCells);
      }
    }
  }

  if (fromVersion < 5) {
    // v5 introduces the 'in_progress' task status with a locked cell+building.
    // No existing rows match that state, so this is just a version bump.
    for (const t of data.tasks) {
      if (t.status !== 'pending' && t.status !== 'complete') {
        t.status = 'pending';
      }
    }
  }

  data.version = VERSION;
  return true;
}

let _state = null;
const _listeners = new Set();

function notify() {
  for (const fn of _listeners) {
    try { fn(_state); } catch (err) { console.error('store listener error', err); }
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(_state));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      window.dispatchEvent(new CustomEvent('citylog:quota-exceeded'));
    } else {
      console.error('store persist error', err);
    }
  }
}

export const store = {
  load() {
    if (_state) return _state;
    let parsed = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch (err) {
      console.error('store load failed, using fresh state', err);
      window.dispatchEvent(new CustomEvent('citylog:data-error'));
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.districts)) {
      _state = emptyData();
    } else {
      _state = {
        version: Number(parsed.version) || 1,
        districts: parsed.districts,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        meta: parsed.meta && typeof parsed.meta === 'object'
          ? {
              installSeed: parsed.meta.installSeed ?? Math.floor(Math.random() * 0xffffffff),
              installedAt: parsed.meta.installedAt ?? nowIso(),
              cursors: parsed.meta.cursors ?? {},
              events: Array.isArray(parsed.meta.events) ? parsed.meta.events : [],
              settings: parsed.meta.settings ? { ...DEFAULT_SETTINGS, ...parsed.meta.settings } : { ...DEFAULT_SETTINGS },
              activeTab: parsed.meta.activeTab || 'city'
            }
          : emptyData().meta
      };
    }

    seedDefaults(_state);
    migrate(_state);
    persist();
    return _state;
  },

  save(data) {
    if (data) _state = data;
    persist();
    notify();
  },

  persistSilently() {
    persist();
  },

  subscribe(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  },

  getDistricts() {
    return [..._state.districts].sort((a, b) => a.order - b.order);
  },

  getDistrict(id) {
    return _state.districts.find(d => d.id === id) || null;
  },

  addDistrict(name, color) {
    const order = _state.districts.length === 0
      ? 0
      : Math.max(..._state.districts.map(d => d.order)) + 1;
    const district = {
      id: uuid(),
      name: String(name || 'Untitled').trim().slice(0, 40),
      color: color || '#00f5ff',
      order,
      size: INITIAL_DISTRICT_SIZE,
      createdAt: nowIso()
    };
    _state.districts.push(district);
    persist();
    notify();
    return district;
  },

  growDistrictIfNeeded(districtId) {
    const d = _state.districts.find(x => x.id === districtId);
    if (!d) return false;
    if (typeof d.size !== 'number') d.size = INITIAL_DISTRICT_SIZE;
    const count = _state.tasks.filter(t => t.districtId === districtId).length;
    let grew = false;
    while (count > d.size * d.size) {
      d.size += 1;
      grew = true;
    }
    if (grew) persist();
    return grew;
  },

  setActiveTab(tab) {
    if (!_state.meta) _state.meta = {};
    _state.meta.activeTab = tab;
    persist();
  },

  updateDistrict(id, patch) {
    const d = _state.districts.find(x => x.id === id);
    if (!d) return null;
    if (patch.name !== undefined) d.name = String(patch.name).trim().slice(0, 40);
    if (patch.color !== undefined) d.color = patch.color;
    if (patch.order !== undefined) d.order = patch.order;
    persist();
    notify();
    return d;
  },

  reorderDistricts(orderedIds) {
    orderedIds.forEach((id, i) => {
      const d = _state.districts.find(x => x.id === id);
      if (d) d.order = i;
    });
    _state.meta.events.push({ type: 'districtReorder', at: nowIso() });
    persist();
    notify();
  },

  removeDistrict(id) {
    const hasTasks = _state.tasks.some(t => t.districtId === id);
    if (hasTasks) {
      return { ok: false, reason: 'has_tasks' };
    }
    _state.districts = _state.districts.filter(d => d.id !== id);
    delete _state.meta.cursors[id];
    persist();
    notify();
    return { ok: true };
  },

  reassignAndRemoveDistrict(id, targetId) {
    if (id === targetId) return { ok: false, reason: 'same_target' };
    if (!_state.districts.find(d => d.id === targetId)) {
      return { ok: false, reason: 'no_target' };
    }
    _state.tasks.forEach(t => {
      if (t.districtId === id) t.districtId = targetId;
    });
    _state.districts = _state.districts.filter(d => d.id !== id);
    delete _state.meta.cursors[id];
    persist();
    notify();
    return { ok: true };
  },

  getTasks(districtId) {
    if (districtId) {
      return _state.tasks.filter(t => t.districtId === districtId);
    }
    return [..._state.tasks];
  },

  getTask(id) {
    return _state.tasks.find(t => t.id === id) || null;
  },

  addTask(title, districtId) {
    const now = nowIso();
    const task = {
      id: uuid(),
      title: String(title || '').trim().slice(0, 200),
      districtId,
      status: 'pending',
      createdAt: now,
      startedAt: null,
      completedAt: null,
      building: null,
      priority: now
    };
    _state.tasks.push(task);
    this.growDistrictIfNeeded(districtId);
    persist();
    notify();
    return task;
  },

  startTask(id, buildingData) {
    const task = _state.tasks.find(t => t.id === id);
    if (!task || task.status !== 'pending') return null;
    task.status = 'in_progress';
    task.startedAt = nowIso();
    task.building = buildingData;
    persist();
    notify();
    return task;
  },

  completeTask(id, buildingData) {
    const task = _state.tasks.find(t => t.id === id);
    if (!task || task.status === 'complete') return null;
    // If a building was already locked (in_progress -> complete), keep the
    // exact same cell and seed so the wireframe matches the rising building.
    if (!task.building) task.building = buildingData;
    task.status = 'complete';
    task.completedAt = nowIso();
    persist();
    notify();
    return task;
  },

  deleteTask(id) {
    const idx = _state.tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;
    const removed = _state.tasks.splice(idx, 1)[0];
    const snapshot = { task: JSON.parse(JSON.stringify(removed)), index: idx };
    persist();
    notify();
    return snapshot;
  },

  restoreTask(snapshot) {
    if (!snapshot || !snapshot.task) return null;
    if (_state.tasks.some(t => t.id === snapshot.task.id)) return null;
    const idx = Math.min(snapshot.index, _state.tasks.length);
    _state.tasks.splice(idx, 0, snapshot.task);
    this.growDistrictIfNeeded(snapshot.task.districtId);
    persist();
    notify();
    return snapshot.task;
  },

  setPriority(id, priority) {
    const t = _state.tasks.find(x => x.id === id);
    if (!t) return null;
    t.priority = priority;
    persist();
    notify();
    return t;
  },

  reorderPending(orderedIds) {
    const base = Date.now();
    orderedIds.forEach((id, i) => {
      const t = _state.tasks.find(x => x.id === id);
      if (t) t.priority = new Date(base + i).toISOString();
    });
    persist();
    notify();
  },

  getCursor(districtId) {
    return _state.meta.cursors[districtId] ?? null;
  },

  setCursor(districtId, cursor) {
    _state.meta.cursors[districtId] = cursor;
    persist();
  },

  resetCursor(districtId) {
    delete _state.meta.cursors[districtId];
    persist();
  },

  installSeed() {
    return _state.meta.installSeed;
  },

  raw() {
    return _state;
  },

  reset() {
    _state = emptyData();
    seedDefaults(_state);
    persist();
    notify();
  }
};
