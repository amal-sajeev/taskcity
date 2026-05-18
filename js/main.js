import { store } from './store.js';
import { mountSheet } from './sheet.js';
import { mountUi } from './ui.js';
import { mountSkyline } from './skyline.js';
import { mountModals } from './modals.js';
import { mountToast, showToast } from './toast.js';
import { settings } from './settings.js';
import { mountKeyboard } from './keyboard.js';
import { mountRouter } from './router.js';
import { mountStats } from './stats.js';

// ── Single source of truth for sheet height on mobile ─────────────────────
// The page layout is CSS Grid; the only dynamic input is --mobile-tasks-h.
// Computing it from window.innerHeight (instead of dvh/svh) makes the split
// stable across iOS Safari / Android Chrome and any browser-chrome state.
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
// When a fresher SW takes over (skipWaiting + clients.claim) the page must
// reload once so it stops being served by the stale controller.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
}

function boot() {
  // Apply before any DOM measurements happen.
  syncLayoutVars();
  store.load();
  settings.attach(store);

  mountToast(document.getElementById('toast-host'));

  // Retained for parity; current builds no longer rely on the draggable sheet.
  mountSheet();

  const skylineApi = mountSkyline({
    canvas: document.getElementById('skyline')
  });

  const modalsApi = mountModals({
    rootEl: document.getElementById('modal-root')
  });

  const uiApi = mountUi({
    store,
    skyline: skylineApi,
    modals: modalsApi
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
          // Refresh focus + canvas size in case it was hidden.
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

  // Refresh active view when underlying store changes.
  store.subscribe(() => {
    const tab = router.getTab();
    if (tab === 'tasks') uiApi.refreshTasksView && uiApi.refreshTasksView();
    if (tab === 'stats') statsApi.refresh();
  });

  mountKeyboard({ ui: uiApi });

  // Reset-view button: visible only when the user has manually panned/zoomed.
  const resetBtn = document.getElementById('btn-reset-camera');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (skylineApi.resetCamera) skylineApi.resetCamera();
    });
    skylineApi.on && skylineApi.on('cameramode', ({ manual }) => {
      resetBtn.hidden = !manual;
    });
  }

  // Recompute the sheet/canvas split whenever the viewport changes (keyboard
  // appears, orientation flip, browser chrome hide/show) and let the canvas
  // redraw at its new size.
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

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('SW registration failed', err);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
