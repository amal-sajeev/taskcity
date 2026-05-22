import { apiPost, ApiError } from './api.js';

// ──────────────────────────────────────────────────────────────────────────
// Sync engine: offline-first, last-write-wins per row.
//
// Data flow:
//   - The store (js/store.js) is the canonical local cache (already in
//     localStorage). Every mutator there calls sync.enqueue(...) after it
//     finishes its in-memory + localStorage write.
//   - This module persists the pending operations queue and per-table
//     cursors separately. While online + signed in it periodically:
//       * Sends the queue + cursors to POST /api/sync
//       * Drops applied ops from the local queue
//       * Merges returned deltas into the store (without re-enqueueing)
//       * Stores the new cursors
//   - Polling cadence: every 30 seconds when the tab is visible, plus an
//     immediate round-trip on `focus`, `visibilitychange -> visible`, and
//     `online`. No websockets, no realtime push.
//   - Conflicts: row-level last-write-wins by `updatedAt`. The server upsert
//     only overwrites when EXCLUDED.updated_at > stored.updated_at, so two
//     devices writing concurrently land on whichever ISO timestamp is later.
// ──────────────────────────────────────────────────────────────────────────

const QUEUE_KEY  = 'citylog.sync.queue';
const CURSOR_KEY = 'citylog.sync.cursors';
const USER_KEY   = 'citylog.sync.userId';

const POLL_INTERVAL_MS = 30_000;
const RETRY_BACKOFF_MS = 5_000;

let _store = null;
let _userId = null;
let _running = false;
let _flushing = false;
let _flushScheduled = false;
let _retryScheduled = false;
let _pollTimer = null;
let _statusListeners = new Set();
let _status = { state: 'idle', detail: '' };
let _enabled = false;

// ── Queue + cursor persistence ────────────────────────────────────────────

function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn('sync: bad queue, dropping', err);
    return [];
  }
}

function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
  catch (err) { console.error('sync: cannot persist queue', err); }
}

function loadCursors() {
  try {
    const raw = localStorage.getItem(CURSOR_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveCursors(c) {
  try { localStorage.setItem(CURSOR_KEY, JSON.stringify(c)); }
  catch (err) { console.error('sync: cannot persist cursors', err); }
}

// Per-user namespacing so switching accounts doesn't reuse stale cursors.
function cursorKey(table) {
  return `${_userId || 'anon'}::${table}`;
}

function readUserCursors() {
  const all = loadCursors();
  return {
    tasks:     all[cursorKey('tasks')]     || null,
    districts: all[cursorKey('districts')] || null,
    user_meta: all[cursorKey('user_meta')] || null
  };
}

function writeUserCursors(c) {
  if (!c) return;
  const all = loadCursors();
  if (c.tasks)     all[cursorKey('tasks')]     = c.tasks;
  if (c.districts) all[cursorKey('districts')] = c.districts;
  if (c.user_meta) all[cursorKey('user_meta')] = c.user_meta;
  saveCursors(all);
}

function makeOpId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'op-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

// ── Status broadcast ──────────────────────────────────────────────────────

function setStatus(state, detail = '') {
  _status = { state, detail };
  for (const fn of _statusListeners) {
    try { fn(_status); } catch (err) { console.error('sync status listener', err); }
  }
}

export function getStatus() { return _status; }

export function onStatus(fn) {
  _statusListeners.add(fn);
  try { fn(_status); } catch (err) { console.error('sync status listener', err); }
  return () => _statusListeners.delete(fn);
}

// ── Public API ────────────────────────────────────────────────────────────

export function attach(store) { _store = store; }
export function enable() { _enabled = true; }
export function isEnabled() { return _enabled; }

export function enqueue(op) {
  // op = { table: 'tasks'|'districts'|'user_meta', kind: 'upsert'|'delete', payload }
  // Persisted even before bootstrap() so writes made during the auth window
  // aren't lost. The flusher refuses to run until _running becomes true.
  if (!_store || !_enabled) return;
  const q = loadQueue();
  q.push({ id: makeOpId(), ...op, queuedAt: new Date().toISOString() });
  saveQueue(q);
  scheduleFlush();
}

export async function bootstrap(opts) {
  if (!_store) throw new Error('sync.attach(store) must be called first');
  _userId = opts.userId;
  try { localStorage.setItem(USER_KEY, _userId); } catch { /* ignore */ }

  _running = true;
  setStatus('syncing', 'Catching up...');

  // Initial round-trip: push whatever's queued, pull deltas from cursors.
  try {
    await syncRoundTrip();
  } catch (err) {
    console.warn('sync: initial round-trip failed', err);
    setStatus('error', err.message || 'sync failed');
  }

  startPolling();
  window.addEventListener('online',  onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('focus',   onFocus);
  document.addEventListener('visibilitychange', onVisibility);

  if (loadQueue().length === 0) setStatus(navigator.onLine ? 'online' : 'offline');
}

export async function teardown() {
  _running = false;
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  window.removeEventListener('online',  onOnline);
  window.removeEventListener('offline', onOffline);
  window.removeEventListener('focus',   onFocus);
  document.removeEventListener('visibilitychange', onVisibility);
  _userId = null;
  try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
}

export function currentUserId() { return _userId; }
export function lastKnownUserId() {
  try { return localStorage.getItem(USER_KEY) || null; }
  catch { return null; }
}

export function pendingCount() { return loadQueue().length; }
export function nudge() { scheduleFlush(); }

// ── Internal: polling timer ───────────────────────────────────────────────

function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => {
    if (!_running) return;
    if (document.visibilityState === 'hidden') return;
    if (!navigator.onLine) return;
    void syncRoundTrip().catch(() => { /* status already updated */ });
  }, POLL_INTERVAL_MS);
}

// ── Internal: round-trip (queue flush + delta pull) ──────────────────────

function scheduleFlush() {
  if (_flushScheduled || _flushing) return;
  _flushScheduled = true;
  setTimeout(() => {
    _flushScheduled = false;
    void syncRoundTrip().catch(() => { /* status already updated */ });
  }, 150);
}

async function syncRoundTrip() {
  if (!_running || !_enabled) return;
  if (_flushing) return;
  if (!navigator.onLine) { setStatus('offline'); return; }

  _flushing = true;
  try {
    const queueSnapshot = loadQueue();
    const cursors = readUserCursors();
    if (queueSnapshot.length > 0) setStatus('syncing', `${queueSnapshot.length} pending`);

    let result;
    try {
      result = await apiPost('/api/sync', { ops: queueSnapshot, cursors });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Session expired. Stop and let main.js's auth flow take over on the
        // next visibility/focus.
        setStatus('error', 'Sign in required');
        _running = false;
        return;
      }
      throw err;
    }

    // Drop applied ops. We compare by id so ops queued while the request was
    // in flight aren't accidentally dropped.
    const appliedIds = new Set(Array.isArray(result.applied) ? result.applied : []);
    if (appliedIds.size > 0) {
      const remaining = loadQueue().filter(op => !appliedIds.has(op.id));
      saveQueue(remaining);
    }

    // Merge deltas into the local store (without re-enqueueing).
    const deltas = result.deltas || {};
    if (Array.isArray(deltas.districts)) {
      for (const row of deltas.districts) {
        _store.applyRemote('districts', row, { silent: true });
      }
    }
    if (Array.isArray(deltas.tasks)) {
      for (const row of deltas.tasks) {
        _store.applyRemote('tasks', row, { silent: true });
      }
    }
    if (deltas.meta && _store.applyRemoteMeta) {
      _store.applyRemoteMeta(deltas.meta);
    }
    // One notify at the end keeps the UI render to a single repaint.
    const touchedAnything =
      (Array.isArray(deltas.districts) && deltas.districts.length > 0) ||
      (Array.isArray(deltas.tasks)     && deltas.tasks.length     > 0);
    if (touchedAnything && _store.notifySubscribers) _store.notifySubscribers();

    // Persist updated cursors.
    writeUserCursors(result.cursors || null);

    const pending = loadQueue().length;
    setStatus(pending === 0 ? 'online' : 'pending', pending === 0 ? '' : `${pending} pending`);
  } catch (err) {
    console.warn('sync round-trip failed', err);
    setStatus('error', describeError(err));
    scheduleRetry();
    throw err;
  } finally {
    _flushing = false;
  }
}

function describeError(err) {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'offline';
    if (err.status >= 500) return 'server error';
    return err.message || 'sync error';
  }
  return (err && err.message) || 'sync error';
}

function scheduleRetry() {
  if (_retryScheduled) return;
  _retryScheduled = true;
  setTimeout(() => {
    _retryScheduled = false;
    if (_running && navigator.onLine && loadQueue().length > 0) {
      void syncRoundTrip().catch(() => {});
    }
  }, RETRY_BACKOFF_MS);
}

// ── Internal: connectivity + visibility ──────────────────────────────────

function onOnline() {
  setStatus('syncing', 'Reconnecting...');
  scheduleFlush();
}

function onOffline() {
  setStatus('offline');
}

function onVisibility() {
  if (document.visibilityState !== 'visible') return;
  if (!_running || !navigator.onLine) return;
  void syncRoundTrip().catch(() => {});
}

function onFocus() {
  if (!_running || !navigator.onLine) return;
  void syncRoundTrip().catch(() => {});
}

// ── Bulk import of existing local data (one-time, first-device sign-in) ──

export async function importLocalSnapshot(snapshot) {
  if (!_userId) throw new Error('not signed in');
  for (const d of snapshot.districts || []) {
    enqueue({ table: 'districts', kind: 'upsert', payload: d });
  }
  for (const t of snapshot.tasks || []) {
    enqueue({ table: 'tasks', kind: 'upsert', payload: t });
  }
  if (snapshot.meta) {
    enqueue({ table: 'user_meta', kind: 'upsert', payload: snapshot.meta });
  }
  scheduleFlush();
}
