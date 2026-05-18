const TABS = ['city', 'tasks', 'stats'];
const DEFAULT_TAB = 'city';

export function mountRouter({ store, views, tabbarEl }) {
  let current = null;
  const tabButtons = tabbarEl ? [...tabbarEl.querySelectorAll('[data-tab]')] : [];
  const desktopButtons = [...document.querySelectorAll('.rail-toggle [data-tab]')];

  const initial = sanitize((store.raw().meta && store.raw().meta.activeTab) || DEFAULT_TAB);

  function sanitize(name) {
    return TABS.includes(name) ? name : DEFAULT_TAB;
  }

  function setTab(name, { persist = true } = {}) {
    const next = sanitize(name);
    if (next === current) return;
    const prev = current;
    current = next;
    document.body.dataset.tab = next;
    paintButtons(next);

    if (prev && views[prev] && typeof views[prev].unmount === 'function') {
      try { views[prev].unmount(); } catch (err) { console.error('view unmount error', err); }
    }
    const view = views[next];
    if (view) {
      if (typeof view.mount === 'function') {
        try { view.mount(); } catch (err) { console.error('view mount error', err); }
      } else if (typeof view.refresh === 'function') {
        try { view.refresh(); } catch (err) { console.error('view refresh error', err); }
      }
    }

    if (persist) {
      try { store.setActiveTab(next); } catch (_) {}
    }
  }

  function paintButtons(name) {
    for (const btn of tabButtons) {
      const on = btn.dataset.tab === name;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('is-active', on);
    }
    for (const btn of desktopButtons) {
      const on = btn.dataset.tab === name;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('is-active', on);
    }
  }

  function refreshCurrent() {
    if (!current) return;
    const v = views[current];
    if (v && typeof v.refresh === 'function') v.refresh();
  }

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }
  for (const btn of desktopButtons) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }

  setTab(initial, { persist: false });

  return {
    setTab,
    getTab: () => current,
    refreshCurrent
  };
}
