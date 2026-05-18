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

// window.innerHeight always reflects the real current visible viewport on
// both iOS Safari and Android Chrome, unlike dvh/svh which can be stale.
function setViewportHeight() {
  document.documentElement.style.setProperty('--wih', `${window.innerHeight}px`);
}
setViewportHeight();
window.addEventListener('resize', setViewportHeight, { passive: true });
// orientationchange fires before innerHeight updates; wait one frame.
window.addEventListener('orientationchange', () => {
  requestAnimationFrame(setViewportHeight);
}, { passive: true });

function boot() {
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

  window.addEventListener('citylog:quota-exceeded', () => {
    showToast('Storage full. Clear completed tasks to continue.', { variant: 'danger', duration: 5000 });
  });
  window.addEventListener('citylog:data-error', () => {
    showToast('Saved data was corrupted. Started fresh.', { variant: 'danger', duration: 5000 });
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('SW registration failed', err);
      });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
