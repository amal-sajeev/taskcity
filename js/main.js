import { store } from './store.js';
import { mountSheet } from './sheet.js';
import { mountUi } from './ui.js';
import { mountSkyline } from './skyline.js';
import { mountModals, _openModal as openModal } from './modals.js';
import { mountToast, showToast } from './toast.js';
import { settings } from './settings.js';
import { mountKeyboard } from './keyboard.js';
import { mountRouter } from './router.js';
import { mountStats } from './stats.js';
import * as sync from './sync.js';
import * as auth from './auth.js';

// ── Single source of truth for sheet height on mobile ─────────────────────
function syncLayoutVars() {
  if (window.matchMedia('(min-width: 900px)').matches) return;
  const vh = window.innerHeight;
  const topbarH = 56;
  const tabbarH = 60;
  const reserve = 160;
  const sheetH = Math.max(180, Math.min(
    Math.round(vh * 0.55),
    vh - topbarH - tabbarH - reserve
  ));
  document.documentElement.style.setProperty('--mobile-tasks-h', sheetH + 'px');
}

// ── Service-worker auto-recovery ──────────────────────────────────────────
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
let _booted = false;

// Mounted early so the auth flow can show confirm dialogs / toasts.
let _modalsApi = null;

async function boot() {
  syncLayoutVars();
  store.load();
  settings.attach(store);
  mountToast(document.getElementById('toast-host'));
  _modalsApi = mountModals({
    rootEl: document.getElementById('modal-root')
  });

  // Mount the full UI immediately so the offline-first paint happens before
  // the auth flow does anything. The login overlay sits on top of this.
  mountAll();
  bindAccountMenu();

  // Tell sync.js it's allowed to queue ops now. Mutations made before the
  // user finishes signing in will sit in the queue and flush after.
  sync.attach(store);
  sync.enable();

  const session = await auth.getSession();
  if (session.ok && session.data) {
    continueAfterAuth(session.data);
  } else {
    if (!session.ok) {
      // Couldn't reach /api/auth/me at all (network / cold start fail).
      // Still let the user see and use the offline-first cache; the login
      // overlay will appear so they can sign in once connectivity returns.
      paintAccountChip({ state: 'offline', label: 'offline' });
    }
    showLoginView();
  }
}

async function continueAfterAuth(session) {
  if (_booted) return;
  _booted = true;

  const userId = session.user.id;
  const email = session.user.email || '';

  // Decide what to do with whatever localStorage already holds.
  const previousUserId = sync.lastKnownUserId();
  const snapshot = store.exportSnapshot();
  const hasInterestingLocal = (snapshot.tasks || []).length > 0;

  if (previousUserId && previousUserId !== userId) {
    // A different user signed in on this device.
    const proceed = await confirmSwitchUser(email);
    if (!proceed) {
      await auth.signOut();
      setTimeout(() => location.reload(), 50);
      return;
    }
    store.clear();
  } else if (!previousUserId) {
    // First time signing in on THIS device.
    if (hasInterestingLocal) {
      // Real local data (tasks) -- ask before merging or discarding.
      const choice = await confirmImportLocal();
      if (choice === 'discard') store.clear();
      // 'import' keeps the local snapshot in memory for upload after pull.
    } else {
      // Just freshly-seeded default districts (or nothing). Drop them so
      // they don't collide with whatever the server returns.
      store.clear();
    }
  }

  // Pull deltas. After this returns, local state reflects the server,
  // merged with any local snapshot we deliberately kept.
  await sync.bootstrap({ userId });

  if (!previousUserId) {
    // If both the device cache and the server were empty, seed the fresh
    // default districts locally so the user has somewhere to put tasks.
    store.seedDefaultsIfEmpty();
    // Push the current state so the server has whatever we kept or seeded.
    const post = store.exportSnapshot();
    if (post.districts.length > 0 || post.tasks.length > 0) {
      try { await sync.importLocalSnapshot(post); }
      catch (err) { console.warn('initial sync push failed', err); }
    }
  }

  paintAccountChip({ state: 'online', label: email || 'signed in' });
  paintAccountMenu(email);

  sync.onStatus(({ state, detail }) => {
    if (state === 'syncing') paintAccountChip({ state: 'syncing', label: detail || 'syncing' });
    else if (state === 'offline') paintAccountChip({ state: 'offline', label: 'offline' });
    else if (state === 'error') paintAccountChip({ state: 'error', label: 'sync error' });
    else if (state === 'pending') paintAccountChip({ state: 'syncing', label: detail || 'pending' });
    else paintAccountChip({ state: 'online', label: email || 'online' });
  });
}

// ── Mount everything (called once during boot, before auth gates) ────────

function mountAll() {
  // Retained for parity; current builds no longer rely on the draggable sheet.
  mountSheet();

  const skylineApi = mountSkyline({
    canvas: document.getElementById('skyline')
  });

  const uiApi = mountUi({
    store,
    skyline: skylineApi,
    modals: _modalsApi
  });

  const statsApi = mountStats({
    store,
    containerEl: document.getElementById('stats-view')
  });

  const router = mountRouter({
    store,
    tabbarEl: document.getElementById('tabbar'),
    views: {
      city: {
        mount() {
          if (skylineApi.refreshCamera) skylineApi.refreshCamera();
          skylineApi.render(store.raw());
          uiApi.refresh();
        }
      },
      tasks: {
        mount() { uiApi.refreshTasksView && uiApi.refreshTasksView(); },
        refresh() { uiApi.refreshTasksView && uiApi.refreshTasksView(); }
      },
      stats: {
        mount() { statsApi.mount(); },
        refresh() { statsApi.refresh(); }
      }
    }
  });

  store.subscribe(() => {
    const tab = router.getTab();
    if (tab === 'tasks') uiApi.refreshTasksView && uiApi.refreshTasksView();
    if (tab === 'stats') statsApi.refresh();
  });

  mountKeyboard({ ui: uiApi });

  const resetBtn = document.getElementById('btn-reset-camera');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (skylineApi.resetCamera) skylineApi.resetCamera();
    });
    skylineApi.on && skylineApi.on('cameramode', ({ manual }) => {
      resetBtn.hidden = !manual;
    });
  }

  function onViewportChange() {
    syncLayoutVars();
    if (skylineApi.refreshCamera) skylineApi.refreshCamera();
    skylineApi.render(store.raw());
  }
  window.addEventListener('resize', onViewportChange, { passive: true });
  window.addEventListener('orientationchange', () => {
    requestAnimationFrame(onViewportChange);
  }, { passive: true });

  window.addEventListener('citylog:quota-exceeded', () => {
    showToast('Storage full. Clear completed tasks to continue.', { variant: 'danger', duration: 5000 });
  });
  window.addEventListener('citylog:data-error', () => {
    showToast('Saved data was corrupted. Started fresh.', { variant: 'danger', duration: 5000 });
  });
}

// ── Login view ────────────────────────────────────────────────────────────

let _loginBound = false;

function showLoginView() {
  const view = document.getElementById('login-view');
  if (!view) return;
  view.hidden = false;
  if (_loginBound) {
    setTimeout(() => {
      const e = document.getElementById('login-email');
      if (e) e.focus();
    }, 80);
    return;
  }
  _loginBound = true;

  const form        = document.getElementById('login-form');
  const emailEl     = document.getElementById('login-email');
  const passwordEl  = document.getElementById('login-password');
  const submitEl    = document.getElementById('login-submit');
  const submitLabel = document.getElementById('login-submit-label');
  const statusEl    = document.getElementById('login-status');
  const ledeEl      = document.getElementById('login-lede');
  const togglePrompt= document.getElementById('login-toggle-prompt');
  const toggleBtn   = document.getElementById('login-toggle');

  // mode: 'signin' (default) or 'signup'. Toggle button flips it.
  function applyMode(mode) {
    toggleBtn.dataset.mode = mode;
    if (mode === 'signup') {
      submitLabel.textContent = 'Create account';
      togglePrompt.textContent = 'Already have an account?';
      toggleBtn.textContent = 'Sign in instead';
      passwordEl.setAttribute('autocomplete', 'new-password');
      ledeEl.textContent = 'Create an account to sync across devices.';
    } else {
      submitLabel.textContent = 'Sign in';
      togglePrompt.textContent = 'New here?';
      toggleBtn.textContent = 'Create an account';
      passwordEl.setAttribute('autocomplete', 'current-password');
      ledeEl.textContent = 'Build your city across every device.';
    }
    setLoginStatus(statusEl, '');
  }

  toggleBtn.addEventListener('click', () => {
    const current = toggleBtn.dataset.mode || 'signin';
    applyMode(current === 'signup' ? 'signin' : 'signup');
    emailEl.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (emailEl.value || '').trim();
    const password = passwordEl.value || '';
    const mode = toggleBtn.dataset.mode || 'signin';
    if (!email) {
      setLoginStatus(statusEl, 'Email is required.', 'error');
      emailEl.focus();
      return;
    }
    if (!password || password.length < 6) {
      setLoginStatus(statusEl, 'Password must be at least 6 characters.', 'error');
      passwordEl.focus();
      return;
    }
    if (!navigator.onLine) {
      setLoginStatus(statusEl, 'You are offline. Reconnect to sign in.', 'error');
      return;
    }
    submitEl.disabled = true;
    setLoginStatus(statusEl, mode === 'signup' ? 'Creating account...' : 'Signing in...');
    const r = mode === 'signup'
      ? await auth.signUp(email, password)
      : await auth.signIn(email, password);
    submitEl.disabled = false;
    if (r.ok && r.data && r.data.user) {
      setLoginStatus(statusEl, 'Welcome.', 'ok');
      hideLoginView();
      continueAfterAuth(r.data);
    } else {
      setLoginStatus(statusEl, r.error || 'Something went wrong.', 'error');
    }
  });

  setTimeout(() => emailEl && emailEl.focus(), 80);
}

function hideLoginView() {
  const view = document.getElementById('login-view');
  if (view) view.hidden = true;
}

function setLoginStatus(el, text, variant) {
  if (!el) return;
  el.textContent = text || '';
  if (variant) el.dataset.variant = variant;
  else delete el.dataset.variant;
}

// ── Account chip + menu ───────────────────────────────────────────────────

function paintAccountChip({ state, label }) {
  const chip = document.getElementById('btn-account');
  const lab  = document.getElementById('account-chip-label');
  if (!chip) return;
  chip.hidden = false;
  chip.dataset.state = state;
  if (lab) lab.textContent = label || '';
}

function paintAccountMenu(email) {
  const emailEl = document.getElementById('account-email');
  const avatar  = document.getElementById('account-avatar');
  if (emailEl) emailEl.textContent = email || 'signed in';
  if (avatar)  avatar.textContent  = (email || '?').charAt(0).toUpperCase();
}

function bindAccountMenu() {
  const chip = document.getElementById('btn-account');
  const menu = document.getElementById('account-menu');
  const signoutBtn = document.getElementById('account-signout');
  if (!chip || !menu || !signoutBtn) return;

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (e.target.closest('#account-menu') || e.target.closest('#btn-account')) return;
    menu.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) menu.hidden = true;
  });

  signoutBtn.addEventListener('click', async () => {
    menu.hidden = true;
    showToast('Signing out...');
    await sync.teardown();
    await auth.signOut();
    // Wipe local cache so the next account starts clean. The seeded defaults
    // come back via store.load() on the next boot.
    try { localStorage.removeItem('citylog_data'); } catch { /* ignore */ }
    try { localStorage.removeItem('citylog.sync.queue'); } catch { /* ignore */ }
    setTimeout(() => location.reload(), 100);
  });
}

// ── Confirm dialog for cross-user sign-in ─────────────────────────────────

function confirmImportLocal() {
  return new Promise((resolve) => {
    openModal(({ modal, close }) => {
      modal.innerHTML = `
        <h2 class="modal__title">Welcome!</h2>
        <p style="margin: 8px 0 16px 0; color: var(--text-secondary); font-size: 13px;">
          You have local CITYLOG data on this device from before sync was
          enabled. Import it to your account so it appears on every device,
          or discard and start fresh from your account.
        </p>
        <div class="modal__actions">
          <button type="button" class="btn btn--ghost" data-action="discard">Discard local</button>
          <button type="button" class="btn btn--primary" data-action="import">Import to account</button>
        </div>
      `;
      modal.querySelector('[data-action="discard"]').addEventListener('click', () => {
        close();
        resolve('discard');
      });
      modal.querySelector('[data-action="import"]').addEventListener('click', () => {
        close();
        resolve('import');
      });
    });
  });
}

function confirmSwitchUser(newEmail) {
  return new Promise((resolve) => {
    openModal(({ modal, close }) => {
      modal.innerHTML = `
        <h2 class="modal__title">Switch account?</h2>
        <p style="margin: 8px 0 16px 0; color: var(--text-secondary); font-size: 13px;">
          This device has local data from a different account. Continuing as
          <strong>${escapeHtml(newEmail || 'this user')}</strong>
          will discard the local cache and load fresh data from the server.
        </p>
        <div class="modal__actions">
          <button type="button" class="btn btn--ghost" data-action="cancel">Cancel</button>
          <button type="button" class="btn btn--primary" data-action="ok">Switch and load</button>
        </div>
      `;
      modal.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        close();
        resolve(false);
      });
      modal.querySelector('[data-action="ok"]').addEventListener('click', () => {
        close();
        resolve(true);
      });
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ── Service worker registration ───────────────────────────────────────────
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => {
    console.warn('SW registration failed', err);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
