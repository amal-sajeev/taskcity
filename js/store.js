// Note: layout.js is intentionally not imported here so that migration logic
// is self-contained against future layout changes.
//
// The store is offline-first: every mutator updates the in-memory state,
// persists to localStorage, notifies subscribers, and (when sync.js has been
// wired) enqueues a sync operation. Sync.js pulls remote changes and pushes
// them back into the store via `applyRemote` / `applyRemoteMeta`, which set
// `__skipSync = true` so the change doesn't bounce back to the server.

import * as sync from './sync.js';

const KEY = 'citylog_data';
const VERSION = 6;
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
        createdAt: nowIso(),
        updatedAt: nowIso()
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
    for (const t of data.tasks) {
      if (t.status !== 'pending' && t.status !== 'complete') {
        t.status = 'pending';
      }
    }
  }

  if (fromVersion < 6) {
    // v6 introduces updatedAt / deletedAt for sync.
    const now = nowIso();
    for (const d of data.districts) {
      if (!d.updatedAt) d.updatedAt = d.createdAt || now;
      if (d.deletedAt === undefined) d.deletedAt = null;
    }
    for (const t of data.tasks) {
      if (!t.updatedAt) t.updatedAt = t.completedAt || t.startedAt || t.createdAt || now;
      if (t.deletedAt === undefined) t.deletedAt = null;
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

// Helpers used by mutators to keep updatedAt fresh and enqueue sync ops.
function touchTask(t) { t.updatedAt = nowIso(); return t; }
function touchDistrict(d) { d.updatedAt = nowIso(); return d; }

function pushTaskSync(task, kind = 'upsert') {
  try { sync.enqueue({ table: 'tasks', kind, payload: task }); }
  catch (err) { /* sync not ready yet; that's fine */ }
}

function pushDistrictSync(district, kind = 'upsert') {
  try { sync.enqueue({ table: 'districts', kind, payload: district }); }
  catch (err) { /* sync not ready yet; that's fine */ }
}

function pushMetaSync() {
  try { sync.enqueue({ table: 'user_meta', kind: 'upsert', payload: serializeMeta(_state.meta) }); }
  catch (err) { /* sync not ready yet; that's fine */ }
}

function serializeMeta(meta) {
  // Only sync the parts that are useful cross-device. cursors/events are
  // per-device caches and stay local.
  return {
    installSeed: meta.installSeed,
    activeTab: meta.activeTab,
    settings: meta.settings
  };
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

  // Public hook so sync.js can batch a sequence of silent applyRemote() calls
  // and trigger a single UI repaint at the end.
  notifySubscribers() { notify(); },

  getDistricts() {
    return _state.districts
      .filter(d => !d.deletedAt)
      .sort((a, b) => a.order - b.order);
  },

  getDistrict(id) {
    const d = _state.districts.find(x => x.id === id) || null;
    return d && !d.deletedAt ? d : null;
  },

  addDistrict(name, color) {
    const visible = _state.districts.filter(d => !d.deletedAt);
    const order = visible.length === 0
      ? 0
      : Math.max(...visible.map(d => d.order)) + 1;
    const now = nowIso();
    const district = {
      id: uuid(),
      name: String(name || 'Untitled').trim().slice(0, 40),
      color: color || '#00f5ff',
      order,
      size: INITIAL_DISTRICT_SIZE,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    _state.districts.push(district);
    persist();
    notify();
    pushDistrictSync(district);
    return district;
  },

  growDistrictIfNeeded(districtId) {
    const d = _state.districts.find(x => x.id === districtId);
    if (!d) return false;
    if (typeof d.size !== 'number') d.size = INITIAL_DISTRICT_SIZE;
    const count = _state.tasks.filter(t => t.districtId === districtId && !t.deletedAt).length;
    let grew = false;
    while (count > d.size * d.size) {
      d.size += 1;
      grew = true;
    }
    if (grew) {
      touchDistrict(d);
      persist();
      pushDistrictSync(d);
    }
    return grew;
  },

  setActiveTab(tab) {
    if (!_state.meta) _state.meta = {};
    _state.meta.activeTab = tab;
    persist();
    pushMetaSync();
  },

  updateDistrict(id, patch) {
    const d = _state.districts.find(x => x.id === id);
    if (!d) return null;
    if (patch.name !== undefined) d.name = String(patch.name).trim().slice(0, 40);
    if (patch.color !== undefined) d.color = patch.color;
    if (patch.order !== undefined) d.order = patch.order;
    touchDistrict(d);
    persist();
    notify();
    pushDistrictSync(d);
    return d;
  },

  reorderDistricts(orderedIds) {
    orderedIds.forEach((id, i) => {
      const d = _state.districts.find(x => x.id === id);
      if (d) {
        d.order = i;
        touchDistrict(d);
        pushDistrictSync(d);
      }
    });
    _state.meta.events.push({ type: 'districtReorder', at: nowIso() });
    persist();
    notify();
  },

  removeDistrict(id) {
    const hasTasks = _state.tasks.some(t => t.districtId === id && !t.deletedAt);
    if (hasTasks) {
      return { ok: false, reason: 'has_tasks' };
    }
    const d = _state.districts.find(x => x.id === id);
    if (!d) return { ok: false, reason: 'not_found' };
    d.deletedAt = nowIso();
    touchDistrict(d);
    delete _state.meta.cursors[id];
    persist();
    notify();
    pushDistrictSync(d, 'delete');
    return { ok: true };
  },

  reassignAndRemoveDistrict(id, targetId) {
    if (id === targetId) return { ok: false, reason: 'same_target' };
    const target = _state.districts.find(d => d.id === targetId && !d.deletedAt);
    if (!target) return { ok: false, reason: 'no_target' };
    _state.tasks.forEach(t => {
      if (t.districtId === id && !t.deletedAt) {
        t.districtId = targetId;
        touchTask(t);
        pushTaskSync(t);
      }
    });
    const d = _state.districts.find(x => x.id === id);
    if (d) {
      d.deletedAt = nowIso();
      touchDistrict(d);
      pushDistrictSync(d, 'delete');
    }
    delete _state.meta.cursors[id];
    persist();
    notify();
    return { ok: true };
  },

  getTasks(districtId) {
    const all = _state.tasks.filter(t => !t.deletedAt);
    if (districtId) return all.filter(t => t.districtId === districtId);
    return all;
  },

  getTask(id) {
    const t = _state.tasks.find(x => x.id === id) || null;
    return t && !t.deletedAt ? t : null;
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
      priority: now,
      updatedAt: now,
      deletedAt: null
    };
    _state.tasks.push(task);
    this.growDistrictIfNeeded(districtId);
    persist();
    notify();
    pushTaskSync(task);
    return task;
  },

  startTask(id, buildingData) {
    const task = _state.tasks.find(t => t.id === id);
    if (!task || task.status !== 'pending') return null;
    task.status = 'in_progress';
    task.startedAt = nowIso();
    task.building = buildingData;
    touchTask(task);
    persist();
    notify();
    pushTaskSync(task);
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
    touchTask(task);
    persist();
    notify();
    pushTaskSync(task);
    return task;
  },

  deleteTask(id) {
    const t = _state.tasks.find(x => x.id === id);
    if (!t) return null;
    const idx = _state.tasks.indexOf(t);
    const snapshot = { task: JSON.parse(JSON.stringify(t)), index: idx };
    t.deletedAt = nowIso();
    touchTask(t);
    persist();
    notify();
    pushTaskSync(t, 'delete');
    return snapshot;
  },

  restoreTask(snapshot) {
    if (!snapshot || !snapshot.task) return null;
    const existing = _state.tasks.find(t => t.id === snapshot.task.id);
    const restored = { ...snapshot.task, deletedAt: null };
    touchTask(restored);
    if (existing) {
      Object.assign(existing, restored);
    } else {
      const idx = Math.min(snapshot.index, _state.tasks.length);
      _state.tasks.splice(idx, 0, restored);
    }
    this.growDistrictIfNeeded(restored.districtId);
    persist();
    notify();
    pushTaskSync(restored);
    return restored;
  },

  setPriority(id, priority) {
    const t = _state.tasks.find(x => x.id === id);
    if (!t) return null;
    t.priority = priority;
    touchTask(t);
    persist();
    notify();
    pushTaskSync(t);
    return t;
  },

  reorderPending(orderedIds) {
    const base = Date.now();
    orderedIds.forEach((id, i) => {
      const t = _state.tasks.find(x => x.id === id);
      if (t) {
        t.priority = new Date(base + i).toISOString();
        touchTask(t);
        pushTaskSync(t);
      }
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
  },

  // Empty the local cache WITHOUT re-seeding the default districts. Used by
  // the sign-in flow so we don't merge fresh locally-generated defaults on
  // top of whatever the server already holds.
  clear() {
    _state = emptyData();
    persist();
    notify();
  },

  seedDefaultsIfEmpty() {
    if (_state.districts.filter(d => !d.deletedAt).length === 0) {
      seedDefaults(_state);
      persist();
      notify();
    }
  },

  // ── Snapshot helpers for sync.js ────────────────────────────────────────

  exportSnapshot() {
    // Strips per-device meta (cursors, events) so the import is clean across
    // devices.
    return {
      districts: _state.districts.filter(d => !d.deletedAt).map(d => ({ ...d })),
      tasks: _state.tasks.filter(t => !t.deletedAt).map(t => ({ ...t })),
      meta: serializeMeta(_state.meta)
    };
  },

  // ── Remote merge (called by sync.js, does NOT re-enqueue) ──────────────

  applyRemote(table, row, opts = {}) {
    if (!row || !row.id) return;
    if (table === 'tasks') {
      const existing = _state.tasks.find(t => t.id === row.id);
      if (existing) {
        // Last-write-wins per row by updatedAt.
        if (!existing.updatedAt || (row.updatedAt && row.updatedAt >= existing.updatedAt)) {
          Object.assign(existing, row);
        }
      } else {
        _state.tasks.push({ ...row });
      }
      persist();
      if (!opts.silent) notify();
    } else if (table === 'districts') {
      const existing = _state.districts.find(d => d.id === row.id);
      if (existing) {
        if (!existing.updatedAt || (row.updatedAt && row.updatedAt >= existing.updatedAt)) {
          Object.assign(existing, row);
        }
      } else {
        _state.districts.push({ ...row });
      }
      persist();
      if (!opts.silent) notify();
    }
  },

  applyRemoteMeta(metaData) {
    if (!metaData || typeof metaData !== 'object') return;
    if (!_state.meta) _state.meta = {};
    if (metaData.installSeed != null) _state.meta.installSeed = metaData.installSeed;
    if (metaData.activeTab) _state.meta.activeTab = metaData.activeTab;
    if (metaData.settings) {
      _state.meta.settings = { ...DEFAULT_SETTINGS, ..._state.meta.settings, ...metaData.settings };
    }
    persist();
    notify();
  },

  // Replace the entire local cache (used when signing in as a different user).
  replaceState(next) {
    _state = next || emptyData();
    seedDefaults(_state);
    migrate(_state);
    persist();
    notify();
  }
};
