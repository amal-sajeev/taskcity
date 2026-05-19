import { createTask, completeTask, cycleTask, deleteTask } from './tasks.js';
import { showToast } from './toast.js';
import { attachSwipe } from './swipe.js';
import { settings } from './settings.js';
import * as audio from './audio.js';

const ALL = 'all';

let activeDistrictId = ALL;
let openMenuTaskId = null;

const buildingIconSvg = `
<svg viewBox="0 0 18 24" aria-hidden="true">
  <rect x="2" y="6" width="14" height="18" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2,2"/>
  <line x1="5" y1="10" x2="5" y2="22" stroke="currentColor" stroke-width="0.6" opacity="0.7"/>
  <line x1="9" y1="10" x2="9" y2="22" stroke="currentColor" stroke-width="0.6" opacity="0.7"/>
  <line x1="13" y1="10" x2="13" y2="22" stroke="currentColor" stroke-width="0.6" opacity="0.7"/>
</svg>
`.trim();

const completedIconSvg = `
<svg viewBox="0 0 18 24" aria-hidden="true">
  <rect x="2" y="6" width="14" height="18" fill="currentColor" opacity="0.18"/>
  <rect x="2" y="6" width="14" height="18" fill="none" stroke="currentColor" stroke-width="1"/>
  <rect x="4" y="9" width="2" height="2" fill="currentColor"/>
  <rect x="8" y="9" width="2" height="2" fill="currentColor" opacity="0.4"/>
  <rect x="12" y="9" width="2" height="2" fill="currentColor"/>
  <rect x="4" y="13" width="2" height="2" fill="currentColor" opacity="0.5"/>
  <rect x="8" y="13" width="2" height="2" fill="currentColor"/>
  <rect x="12" y="13" width="2" height="2" fill="currentColor" opacity="0.4"/>
  <rect x="4" y="17" width="2" height="2" fill="currentColor"/>
  <rect x="8" y="17" width="2" height="2" fill="currentColor" opacity="0.5"/>
  <rect x="12" y="17" width="2" height="2" fill="currentColor"/>
</svg>
`.trim();

const checkSvg = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2.5" d="M5 12l4 4L19 7"/></svg>';
const trashSvg = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>';
// Half-filled circle (right hemisphere) with a small play triangle inside.
const inProgressSvg = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" opacity="0.55" d="M12 4a8 8 0 0 1 0 16Z"/><polygon fill="currentColor" points="10,9 16,12 10,15"/></svg>';

export function mountUi({ store, skyline, modals }) {
  const tabsEl = document.getElementById('district-tabs');
  const pendingListEl = document.getElementById('task-list-pending');
  const completedListEl = document.getElementById('task-list-completed');
  const completedSection = document.getElementById('completed-section');
  const completedCountEl = document.getElementById('completed-count');
  const emptyEl = document.getElementById('empty-state');
  const statsChip = document.getElementById('stats-chip');
  const sheetStats = document.getElementById('sheet-stats');
  const addBtn = document.getElementById('btn-add-task');
  const addChip = document.getElementById('btn-add-task-chip');
  const districtsBtn = document.getElementById('btn-districts');
  const quickAddForm = document.getElementById('quick-add');
  const quickAddInput = document.getElementById('quick-add-input');
  const quickAddClear = document.getElementById('quick-add-clear');

  // TASKS view elements
  const tasksChipsEl = document.getElementById('tasks-chips');
  const tasksListEl = document.getElementById('task-list-all');
  const tasksSortEl = document.getElementById('tasks-sort');
  const tasksShowCompletedEl = document.getElementById('tasks-show-completed');
  const tasksEmptyEl = document.getElementById('empty-state-tasks');

  const swipeHandles = new WeakMap();
  let selectedTaskId = null;
  let lastPendingIds = [];
  let undoTimer = null;
  let lastUndoSnapshot = null;
  let tasksSort = 'priority';
  let searchQuery = '';

  function matchesSearch(task, district) {
    if (!searchQuery) return true;
    const title = (task.title || '').toLowerCase();
    const dname = district ? (district.name || '').toLowerCase() : '';
    return title.includes(searchQuery) || dname.includes(searchQuery);
  }

  function highlightHtml(text, q) {
    if (!q) return escapeHtml(text);
    const src = String(text);
    const lower = src.toLowerCase();
    const parts = [];
    let i = 0;
    while (i < src.length) {
      const idx = lower.indexOf(q, i);
      if (idx === -1) {
        parts.push(escapeHtml(src.slice(i)));
        break;
      }
      if (idx > i) parts.push(escapeHtml(src.slice(i, idx)));
      parts.push(`<mark class="task__match">${escapeHtml(src.slice(idx, idx + q.length))}</mark>`);
      i = idx + q.length;
    }
    return parts.join('');
  }

  if (tasksShowCompletedEl) {
    const s = store.raw().meta && store.raw().meta.settings;
    tasksShowCompletedEl.checked = !!(s && s.showCompletedInTasks);
  }

  function renderAll() {
    renderTabs();
    renderTasks();
    renderTasksView();
    renderStats();
    skyline.render(store.raw());
    updateActiveDistrictColor();
    updateActiveDistrictAttr();
  }

  function updateActiveDistrictColor() {
    const districts = store.getDistricts();
    let color = '#00f5ff';
    if (activeDistrictId !== ALL) {
      const d = districts.find(x => x.id === activeDistrictId);
      if (d) color = d.color;
    }
    document.documentElement.style.setProperty('--district-color', color);
  }

  function updateActiveDistrictAttr() {
    document.body.dataset.activeDistrict = activeDistrictId === ALL ? 'all' : activeDistrictId;
  }

  function setActiveDistrict(id) {
    activeDistrictId = id;
    if (skyline.setFocus) {
      skyline.setFocus(id === ALL ? null : id);
    }
    renderAll();
  }

  function renderDistrictChips(container, opts = {}) {
    if (!container) return;
    const districts = store.getDistricts();
    const tasks = store.getTasks();
    const pendingByDistrict = new Map();
    for (const t of tasks) {
      if (t.status === 'complete') continue;
      pendingByDistrict.set(t.districtId, (pendingByDistrict.get(t.districtId) || 0) + 1);
    }
    const pendingAll = tasks.filter(t => t.status !== 'complete').length;

    if (activeDistrictId !== ALL && !districts.find(d => d.id === activeDistrictId)) {
      activeDistrictId = ALL;
    }

    container.innerHTML = '';

    const allTab = document.createElement('button');
    allTab.type = 'button';
    allTab.className = 'tab';
    allTab.setAttribute('role', 'tab');
    allTab.setAttribute('aria-selected', activeDistrictId === ALL ? 'true' : 'false');
    allTab.style.setProperty('--district-color', '#c8d4f0');
    allTab.dataset.id = ALL;
    allTab.innerHTML = `
      <span class="tab__dot" style="background: linear-gradient(135deg, #00f5ff, #bf5fff);"></span>
      <span>All</span>
      <span class="tab__count">${pendingAll}</span>
    `;
    allTab.addEventListener('click', () => setActiveDistrict(ALL));
    container.appendChild(allTab);

    for (const d of districts) {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'tab';
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', activeDistrictId === d.id ? 'true' : 'false');
      t.style.setProperty('--district-color', d.color);
      t.dataset.id = d.id;
      const count = pendingByDistrict.get(d.id) || 0;
      t.innerHTML = `
        <span class="tab__dot"></span>
        <span>${escapeHtml(d.name)}</span>
        <span class="tab__count">${count}</span>
      `;
      t.addEventListener('click', () => setActiveDistrict(d.id));
      container.appendChild(t);
    }
  }

  function renderTabs() {
    renderDistrictChips(tabsEl);
  }

  function renderTasks() {
    const districts = store.getDistricts();
    const districtMap = new Map(districts.map(d => [d.id, d]));
    const allTasks = store.getTasks();

    let filtered = activeDistrictId === ALL
      ? allTasks
      : allTasks.filter(t => t.districtId === activeDistrictId);

    filtered = filtered.filter(t => matchesSearch(t, districtMap.get(t.districtId)));

    // Active list: in-progress first (most relevant), then pending by priority.
    const active = filtered
      .filter(t => t.status === 'pending' || t.status === 'in_progress')
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'in_progress' ? -1 : 1;
        const pa = a.priority || a.createdAt || '';
        const pb = b.priority || b.createdAt || '';
        return pa.localeCompare(pb);
      });
    const pending = active; // kept as the variable name used below for staggering
    const completed = filtered
      .filter(t => t.status === 'complete')
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

    const oldPendingIds = lastPendingIds.slice();
    lastPendingIds = pending.map(t => t.id);

    pendingListEl.innerHTML = '';
    let idx = 0;
    for (const task of pending) {
      const d = districtMap.get(task.districtId);
      const row = renderTaskRow(task, d, false);
      // Skip the stagger animation while searching -- the list rebuilds
      // on every keystroke and the cascade would feel noisy.
      const isNew = !oldPendingIds.includes(task.id);
      if (isNew && !searchQuery) {
        row.classList.add('is-stagger');
        row.style.setProperty('--i', String(idx));
      }
      pendingListEl.appendChild(row);
      idx++;
    }
    updateEmptyState(pending.length);

    if (selectedTaskId && !pending.find(t => t.id === selectedTaskId)) {
      selectedTaskId = null;
    }
    refreshSelectedHighlight();

    completedListEl.innerHTML = '';
    for (const task of completed) {
      const d = districtMap.get(task.districtId);
      completedListEl.appendChild(renderTaskRow(task, d, true));
    }
    completedCountEl.textContent = completed.length;
    completedSection.hidden = completed.length === 0;
    // Auto-expand completed when a search matches in there, so the user
    // doesn't have to dig for results behind a collapsed details element.
    if (searchQuery && completed.length > 0) {
      completedSection.open = true;
    }
  }

  function updateEmptyState(activeCount) {
    if (activeCount > 0) {
      emptyEl.hidden = true;
      return;
    }
    if (searchQuery) {
      emptyEl.innerHTML = `<span class="empty-state__icon" aria-hidden="true">\u25A1</span> No active matches for "${escapeHtml(searchQuery)}".`;
    } else {
      emptyEl.innerHTML = `<span class="empty-state__icon" aria-hidden="true">\u25A1</span> No pending directives. The city rests.`;
    }
    emptyEl.hidden = false;
  }

  function renderTasksView() {
    if (!tasksListEl) return;
    renderDistrictChips(tasksChipsEl);

    const districts = store.getDistricts();
    const districtMap = new Map(districts.map(d => [d.id, d]));
    const allTasks = store.getTasks();
    const filtered = activeDistrictId === ALL
      ? allTasks
      : allTasks.filter(t => t.districtId === activeDistrictId);

    const showCompleted = !!(tasksShowCompletedEl && tasksShowCompletedEl.checked);
    let rows = filtered.filter(t => showCompleted || t.status !== 'complete');

    const sortBy = tasksSort;
    rows.sort((a, b) => {
      // in-progress, then pending, then completed
      if (a.status !== b.status) {
        const rank = s => (s === 'in_progress' ? 0 : s === 'pending' ? 1 : 2);
        return rank(a.status) - rank(b.status);
      }
      switch (sortBy) {
        case 'newest':
          return (b.createdAt || '').localeCompare(a.createdAt || '');
        case 'oldest':
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        case 'district': {
          const dA = districtMap.get(a.districtId);
          const dB = districtMap.get(b.districtId);
          const oA = dA ? dA.order : 999;
          const oB = dB ? dB.order : 999;
          if (oA !== oB) return oA - oB;
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        }
        case 'priority':
        default: {
          if (a.status !== 'complete' && b.status !== 'complete') {
            const pa = a.priority || a.createdAt || '';
            const pb = b.priority || b.createdAt || '';
            return pa.localeCompare(pb);
          }
          return (b.completedAt || b.createdAt || '').localeCompare(a.completedAt || a.createdAt || '');
        }
      }
    });

    tasksListEl.innerHTML = '';
    for (const task of rows) {
      const d = districtMap.get(task.districtId);
      const row = renderTaskRow(task, d, task.status === 'complete');
      tasksListEl.appendChild(row);
    }
    if (tasksEmptyEl) tasksEmptyEl.hidden = rows.length !== 0;
  }

  function renderTaskRow(task, district, isCompleted) {
    const li = document.createElement('li');
    const inProgress = task.status === 'in_progress';
    const classes = ['task'];
    if (isCompleted) classes.push('task--completed');
    if (inProgress) classes.push('task--in-progress');
    li.className = classes.join(' ');
    li.dataset.id = task.id;
    li.dataset.status = task.status;
    const color = district ? district.color : '#5a6a90';
    const districtName = district ? district.name : '';
    li.style.setProperty('--district-color', color);
    li.style.setProperty('--row-color', color);

    const circleAria = isCompleted
      ? 'Completed'
      : (inProgress ? 'Complete task' : 'Start task');
    const circleContent = isCompleted
      ? checkSvg
      : (inProgress ? inProgressSvg : '');

    li.innerHTML = `
      <span class="task__trail task__trail--right" aria-hidden="true">
        <span class="task__trail-icon">${checkSvg}</span>
      </span>
      <span class="task__trail task__trail--left" aria-hidden="true">
        <span class="task__trail-icon">${trashSvg}</span>
      </span>
      <div class="task__surface">
        <span class="task__handle" aria-hidden="true"></span>
        <span class="task__icon" style="color:${color};">${isCompleted ? completedIconSvg : buildingIconSvg}</span>
        <span class="task__text">
          <span class="task__title">${highlightHtml(task.title, searchQuery)}</span>
          <span class="task__subtitle" style="color:${color};">${highlightHtml(districtName, searchQuery)}</span>
        </span>
        <button type="button" class="task__complete" aria-label="${circleAria}">
          ${circleContent}
        </button>
      </div>
    `;

    const completeBtn = li.querySelector('.task__complete');
    if (!isCompleted) {
      completeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onCycle(task.id, li);
      });

      const handle = swipeHandles.get(li);
      if (handle) handle.destroy();
      const sw = attachSwipe(li, {
        onComplete: () => onComplete(task.id, li),
        onDelete: () => onDelete(task.id),
        getEnabled: () => true
      });
      swipeHandles.set(li, sw);

      attachSelectOnHover(li, task.id);
      attachLongPressDrag(li, task.id);
    }

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTaskMenu(task.id, li);
    });

    return li;
  }

  function attachSelectOnHover(rowEl, taskId) {
    rowEl.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      selectedTaskId = taskId;
      refreshSelectedHighlight();
    });
  }

  function refreshSelectedHighlight() {
    pendingListEl.querySelectorAll('.task.is-selected').forEach(el => el.classList.remove('is-selected'));
    if (!selectedTaskId) {
      skyline.clearHighlight && skyline.clearHighlight();
      return;
    }
    const row = pendingListEl.querySelector(`[data-id="${selectedTaskId}"]`);
    if (row) row.classList.add('is-selected');

    if (skyline.ghostCellForTask) {
      const g = skyline.ghostCellForTask(selectedTaskId);
      if (g) skyline.highlightCell(g.world, g.color);
      else skyline.clearHighlight && skyline.clearHighlight();
    }
  }

  function attachLongPressDrag(rowEl, taskId) {
    let timer = null;
    let startX = 0, startY = 0;
    let lifted = false;
    let pointerId = null;
    let placeholder = null;
    let lastY = 0;

    function getPendingRows() {
      return [...pendingListEl.querySelectorAll('.task:not(.is-dragging)')];
    }

    function lift(e) {
      lifted = true;
      pointerId = e.pointerId;
      rowEl.classList.add('is-dragging');
      placeholder = document.createElement('li');
      placeholder.className = 'task task--placeholder';
      placeholder.style.height = rowEl.offsetHeight + 'px';
      pendingListEl.insertBefore(placeholder, rowEl);
      const rect = rowEl.getBoundingClientRect();
      rowEl.style.position = 'fixed';
      rowEl.style.left = rect.left + 'px';
      rowEl.style.top = rect.top + 'px';
      rowEl.style.width = rect.width + 'px';
      rowEl.style.zIndex = '70';
      rowEl.style.pointerEvents = 'none';
      lastY = e.clientY;
      try { rowEl.setPointerCapture(pointerId); } catch (_) {}
      settings.haptic(8);
    }

    function move(e) {
      if (!lifted || e.pointerId !== pointerId) return;
      const dy = e.clientY - lastY;
      const top = parseFloat(rowEl.style.top || '0') + dy;
      rowEl.style.top = top + 'px';
      lastY = e.clientY;

      const rows = getPendingRows();
      const cy = e.clientY;
      let inserted = false;
      for (const r of rows) {
        if (r === placeholder) continue;
        const rect = r.getBoundingClientRect();
        if (cy < rect.top + rect.height / 2) {
          if (placeholder.nextElementSibling !== r) {
            pendingListEl.insertBefore(placeholder, r);
          }
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        const last = rows[rows.length - 1];
        if (last && placeholder.previousElementSibling !== last) {
          pendingListEl.appendChild(placeholder);
        }
      }
    }

    function drop(e) {
      if (!lifted) {
        if (timer) { clearTimeout(timer); timer = null; }
        return;
      }
      try { rowEl.releasePointerCapture(pointerId); } catch (_) {}
      pendingListEl.insertBefore(rowEl, placeholder);
      placeholder.remove();
      placeholder = null;
      rowEl.style.position = '';
      rowEl.style.left = '';
      rowEl.style.top = '';
      rowEl.style.width = '';
      rowEl.style.zIndex = '';
      rowEl.style.pointerEvents = '';
      rowEl.classList.remove('is-dragging');
      lifted = false;

      const orderedIds = [...pendingListEl.querySelectorAll('.task')].map(el => el.dataset.id);
      store.reorderPending(orderedIds);
    }

    rowEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.task__complete') || e.target.closest('.task__handle')) {
        if (e.target.closest('.task__handle')) {
          startX = e.clientX; startY = e.clientY;
          lift(e);
          e.preventDefault();
        }
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX; startY = e.clientY;
      timer = setTimeout(() => {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 10) {
          lift(e);
        }
      }, 380);
    });

    rowEl.addEventListener('pointermove', (e) => {
      if (!lifted && timer) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
          clearTimeout(timer);
          timer = null;
        }
      }
      if (lifted) move(e);
    });

    rowEl.addEventListener('pointerup', (e) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (lifted) drop(e);
    });
    rowEl.addEventListener('pointercancel', (e) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (lifted) drop(e);
    });
  }

  function openTaskMenu(taskId, rowEl) {
    closeTaskMenu();
    openMenuTaskId = taskId;
    const menu = document.createElement('div');
    menu.className = 'task__menu';
    menu.innerHTML = `<button type="button" data-action="delete">Delete task</button>`;
    rowEl.appendChild(menu);
    menu.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete(taskId);
      closeTaskMenu();
    });
    setTimeout(() => {
      document.addEventListener('pointerdown', dismissMenu, { once: true });
    }, 0);
  }

  function dismissMenu(e) {
    if (e.target.closest('.task__menu')) return;
    closeTaskMenu();
  }

  function closeTaskMenu() {
    document.querySelectorAll('.task__menu').forEach(m => m.remove());
    openMenuTaskId = null;
  }

  function onComplete(taskId, rowEl) {
    if (!rowEl) rowEl = pendingListEl.querySelector(`[data-id="${taskId}"]`);
    if (rowEl) rowEl.classList.add('is-completing');
    setTimeout(() => {
      completeTask(store, skyline, taskId);
    }, 180);
  }

  function onCycle(taskId, rowEl) {
    const task = store.getTask(taskId);
    if (!task || task.status === 'complete') return;
    if (task.status === 'in_progress') {
      onComplete(taskId, rowEl);
      return;
    }
    // pending -> in_progress: no exit-row animation, just transition in place
    // so the user sees the row state change and the city update together.
    cycleTask(store, skyline, taskId);
  }

  function onDelete(taskId) {
    const task = store.getTask(taskId);
    if (!task) return;
    const wasComplete = task.status === 'complete';
    const snapshot = deleteTask(store, taskId);
    if (wasComplete) {
      showToast('Task deleted. Building stands.');
      return;
    }

    if (undoTimer) {
      clearTimeout(undoTimer);
      undoTimer = null;
    }
    lastUndoSnapshot = snapshot;
    showToast('Directive removed.', {
      action: 'Undo',
      duration: 5000,
      onAction: () => {
        if (lastUndoSnapshot) {
          store.restoreTask(lastUndoSnapshot);
          lastUndoSnapshot = null;
          if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
        }
      }
    });
    undoTimer = setTimeout(() => {
      lastUndoSnapshot = null;
      undoTimer = null;
    }, 5200);
  }

  function renderStats() {
    const tasks = store.getTasks();
    const built = tasks.filter(t => t.status === 'complete').length;
    const pending = tasks.filter(t => t.status !== 'complete').length;
    const text = `${built} building${built === 1 ? '' : 's'} \u00B7 ${pending} pending`;
    statsChip.textContent = text;
    sheetStats.textContent = text;
  }

  addBtn.addEventListener('click', () => openAddTaskModal());
  if (addChip) addChip.addEventListener('click', () => openAddTaskModal());
  districtsBtn.addEventListener('click', () => openDistrictsModal());

  if (quickAddForm) {
    quickAddForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitQuickAdd();
    });
    quickAddInput.addEventListener('focus', () => quickAddForm.classList.add('is-focused'));
    quickAddInput.addEventListener('blur', () => quickAddForm.classList.remove('is-focused'));
    quickAddInput.addEventListener('input', () => {
      applySearchFromInput();
    });
    // type="search" fires a non-bubbling "search" event when the native clear
    // (Webkit X / Esc) is used -- handle it the same way as typing.
    quickAddInput.addEventListener('search', () => applySearchFromInput());
    quickAddInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (quickAddInput.value === '') {
          quickAddInput.blur();
        } else {
          quickAddInput.value = '';
          applySearchFromInput();
        }
      }
    });
    if (quickAddClear) {
      quickAddClear.addEventListener('click', () => {
        quickAddInput.value = '';
        applySearchFromInput();
        quickAddInput.focus();
      });
    }
  }

  function applySearchFromInput() {
    const raw = quickAddInput.value;
    const next = raw.trim().toLowerCase();
    const changed = next !== searchQuery;
    searchQuery = next;
    if (quickAddForm) quickAddForm.classList.toggle('is-searching', !!searchQuery);
    if (quickAddClear) quickAddClear.hidden = !raw;
    if (changed) renderTasks();
  }

  if (tasksSortEl) {
    tasksSortEl.value = tasksSort;
    tasksSortEl.addEventListener('change', () => {
      tasksSort = tasksSortEl.value;
      renderTasksView();
    });
  }
  if (tasksShowCompletedEl) {
    tasksShowCompletedEl.addEventListener('change', () => {
      const meta = store.raw().meta || {};
      meta.settings = meta.settings || {};
      meta.settings.showCompletedInTasks = !!tasksShowCompletedEl.checked;
      store.persistSilently();
      renderTasksView();
    });
  }

  function submitQuickAdd() {
    const value = quickAddInput.value.trim();
    if (!value) return;
    const districts = store.getDistricts();
    if (districts.length === 0) {
      openDistrictsModal({ onboarding: true });
      return;
    }
    const districtId = activeDistrictId !== ALL ? activeDistrictId : districts[0].id;
    const t = createTask(store, value, districtId);
    if (t) {
      quickAddInput.value = '';
      applySearchFromInput();
      if (activeDistrictId !== districtId) {
        setActiveDistrict(districtId);
      }
    }
  }

  function openAddTaskModal() {
    const districts = store.getDistricts();
    if (districts.length === 0) {
      openDistrictsModal({ onboarding: true });
      return;
    }
    const defaultDistrictId = activeDistrictId !== ALL ? activeDistrictId : districts[0].id;
    modals.openAddTask({
      districts,
      defaultDistrictId,
      onSubmit: ({ title, districtId }) => {
        const t = createTask(store, title, districtId);
        if (t && activeDistrictId !== districtId && activeDistrictId !== ALL) {
          setActiveDistrict(districtId);
        }
      }
    });
  }

  function openDistrictsModal(opts = {}) {
    modals.openDistricts({
      store,
      onChange: (info = {}) => {
        if (info && info.added) {
          activeDistrictId = ALL;
          if (skyline.setFocus) skyline.setFocus(null);
        }
        renderAll();
      },
      ...opts
    });
  }

  store.subscribe(() => renderAll());
  skyline.on('resize', () => skyline.render(store.raw()));

  renderAll();

  return {
    refresh: renderAll,
    refreshTasksView: renderTasksView,
    getActiveDistrictId: () => activeDistrictId,
    selectNext() {
      const ids = lastPendingIds;
      if (ids.length === 0) return;
      if (!selectedTaskId) selectedTaskId = ids[0];
      else {
        const i = ids.indexOf(selectedTaskId);
        selectedTaskId = ids[(i + 1) % ids.length];
      }
      audio.play('tap');
      refreshSelectedHighlight();
      scrollSelectedIntoView();
    },
    selectPrev() {
      const ids = lastPendingIds;
      if (ids.length === 0) return;
      if (!selectedTaskId) selectedTaskId = ids[ids.length - 1];
      else {
        const i = ids.indexOf(selectedTaskId);
        selectedTaskId = ids[(i - 1 + ids.length) % ids.length];
      }
      audio.play('tap');
      refreshSelectedHighlight();
      scrollSelectedIntoView();
    },
    completeSelected() {
      if (!selectedTaskId) return;
      const id = selectedTaskId;
      const row = pendingListEl.querySelector(`[data-id="${id}"]`);
      onComplete(id, row);
    },
    deleteSelected() {
      if (!selectedTaskId) return;
      const id = selectedTaskId;
      onDelete(id);
    },
    clearSelection() {
      selectedTaskId = null;
      refreshSelectedHighlight();
    },
    openAddModal: openAddTaskModal,
    openDistrictsModal
  };

  function scrollSelectedIntoView() {
    if (!selectedTaskId) return;
    const row = pendingListEl.querySelector(`[data-id="${selectedTaskId}"]`);
    if (row && row.scrollIntoView) {
      row.scrollIntoView({ block: 'nearest', behavior: settings.isReduced() ? 'auto' : 'smooth' });
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
