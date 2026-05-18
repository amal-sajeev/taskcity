import { settings } from './settings.js';

const PRESET_COLORS = [
  '#00f5ff',
  '#bf5fff',
  '#39ff14',
  '#ff6b35',
  '#ffd700',
  '#ff3d8b',
  '#5fa8ff',
  '#ffffff'
];

export function openDistrictsManager(api, { store, onChange, onboarding = false } = {}) {
  api.open(({ modal, close }) => {
    let pickerColor = PRESET_COLORS[0];
    let reassignTargetByPending = null;

    function render() {
      const districts = store.getDistricts();

      const cur = settings.get();
      modal.innerHTML = `
        <h2 class="modal__title">${onboarding ? 'Create your first district' : 'Districts'}</h2>
        ${onboarding ? '<p style="color:var(--text-secondary); font-size:13px; margin-bottom:14px;">Districts group your tasks. Each one becomes a zone in your skyline.</p>' : ''}
        <div class="district-list" id="district-list"></div>
        <form class="add-district-form" id="add-district-form">
          <div class="add-district-form__row">
            <input type="text" id="new-district-name" placeholder="New district name" maxlength="40" autocomplete="off" />
            <button type="submit" class="btn btn--primary" id="add-district-btn">Add</button>
          </div>
          <div>
            <label class="modal__label" style="margin-bottom: 6px;">Color</label>
            <div class="color-swatches" id="color-swatches"></div>
          </div>
        </form>

        <section class="settings-section">
          <h3 class="settings-section__title">Settings</h3>
          <label class="toggle-row" for="set-sound">
            <span class="toggle-row__label"><strong>Sound effects</strong><small>UI bleeps on add and complete</small></span>
            <input class="toggle" type="checkbox" id="set-sound" ${cur.sound ? 'checked' : ''} />
          </label>
          <label class="toggle-row" for="set-haptics">
            <span class="toggle-row__label"><strong>Haptics</strong><small>Vibrate on supported devices</small></span>
            <input class="toggle" type="checkbox" id="set-haptics" ${cur.haptics ? 'checked' : ''} />
          </label>
          <label class="toggle-row" for="set-motion">
            <span class="toggle-row__label"><strong>Reduce motion</strong><small>Disables drift, beams, sparks, stagger</small></span>
            <input class="toggle" type="checkbox" id="set-motion" ${cur.motion === 'reduce' ? 'checked' : ''} />
          </label>
          <button type="button" class="btn btn--ghost" id="show-shortcuts" style="margin-top:8px; width:100%;">Keyboard shortcuts</button>
        </section>

        <div class="modal__actions">
          <button type="button" class="btn btn--ghost" data-action="done">Done</button>
        </div>
      `;

      const soundEl = modal.querySelector('#set-sound');
      const hapticsEl = modal.querySelector('#set-haptics');
      const motionEl = modal.querySelector('#set-motion');
      soundEl.addEventListener('change', () => settings.set({ sound: soundEl.checked }));
      hapticsEl.addEventListener('change', () => settings.set({ haptics: hapticsEl.checked }));
      motionEl.addEventListener('change', () => settings.set({ motion: motionEl.checked ? 'reduce' : 'auto' }));
      modal.querySelector('#show-shortcuts').addEventListener('click', () => {
        const dlg = document.getElementById('kbd-help');
        if (dlg && typeof dlg.showModal === 'function') {
          try { dlg.showModal(); } catch (_) {}
        }
      });

      const list = modal.querySelector('#district-list');
      for (const d of districts) {
        list.appendChild(renderDistrictRow(d, districts));
      }

      const swatches = modal.querySelector('#color-swatches');
      for (const c of PRESET_COLORS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.background = c;
        b.style.color = c;
        b.dataset.color = c;
        b.setAttribute('aria-label', c);
        b.setAttribute('aria-pressed', c === pickerColor ? 'true' : 'false');
        b.addEventListener('click', () => {
          pickerColor = c;
          swatches.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x.dataset.color === c ? 'true' : 'false'));
        });
        swatches.appendChild(b);
      }

      const form = modal.querySelector('#add-district-form');
      const input = modal.querySelector('#new-district-name');
      const addBtn = modal.querySelector('#add-district-btn');
      addBtn.style.setProperty('--district-color', pickerColor);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) {
          input.focus();
          return;
        }
        store.addDistrict(name, pickerColor);
        if (typeof onChange === 'function') onChange({ added: true });
        render();
      });

      modal.querySelector('[data-action="done"]').addEventListener('click', () => {
        if (typeof onChange === 'function') onChange();
        close();
      });

      enableReorder(list, store, () => {
        if (typeof onChange === 'function') onChange();
      });

      if (onboarding) {
        setTimeout(() => input.focus(), 80);
      }
    }

    function renderDistrictRow(d, allDistricts) {
      const row = document.createElement('div');
      row.className = 'district-row';
      row.dataset.id = d.id;
      row.style.setProperty('--row-color', d.color);
      row.draggable = true;
      row.innerHTML = `
        <span class="district-row__handle" aria-hidden="true">&#8285;&#8285;</span>
        <input class="district-row__name" value="${escapeAttr(d.name)}" maxlength="40" />
        <button type="button" class="district-row__color" aria-label="Change color"></button>
        <button type="button" class="district-row__delete" aria-label="Delete district">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>
      `;

      const nameInput = row.querySelector('.district-row__name');
      nameInput.addEventListener('change', () => {
        store.updateDistrict(d.id, { name: nameInput.value });
        if (typeof onChange === 'function') onChange();
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      });

      const colorBtn = row.querySelector('.district-row__color');
      colorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openColorPopover(colorBtn, d.color, (newColor) => {
          store.updateDistrict(d.id, { color: newColor });
          row.style.setProperty('--row-color', newColor);
          if (typeof onChange === 'function') onChange();
        });
      });

      row.querySelector('.district-row__delete').addEventListener('click', () => {
        const result = store.removeDistrict(d.id);
        if (result.ok) {
          if (typeof onChange === 'function') onChange();
          render();
        } else if (result.reason === 'has_tasks') {
          openReassignDialog(api, store, d, allDistricts.filter(x => x.id !== d.id), () => {
            if (typeof onChange === 'function') onChange();
            render();
          });
        }
      });

      return row;
    }

    render();
  });
}

function enableReorder(listEl, store, onChange) {
  let dragSrc = null;
  listEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.district-row');
    if (!row) return;
    dragSrc = row;
    row.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
  });
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const row = e.target.closest('.district-row');
    if (!row || row === dragSrc) return;
    const rect = row.getBoundingClientRect();
    const after = (e.clientY - rect.top) > rect.height / 2;
    listEl.insertBefore(dragSrc, after ? row.nextSibling : row);
  });
  listEl.addEventListener('dragend', () => {
    if (!dragSrc) return;
    dragSrc.style.opacity = '';
    const ids = Array.from(listEl.querySelectorAll('.district-row')).map(r => r.dataset.id);
    store.reorderDistricts(ids);
    dragSrc = null;
    if (typeof onChange === 'function') onChange();
  });
}

function openColorPopover(anchor, currentColor, onPick) {
  const existing = document.querySelector('.color-popover');
  if (existing) existing.remove();

  const pop = document.createElement('div');
  pop.className = 'color-popover color-swatches';
  pop.style.position = 'absolute';
  pop.style.zIndex = '90';
  pop.style.background = 'var(--bg-panel-strong)';
  pop.style.border = '1px solid var(--bg-panel-border)';
  pop.style.padding = '8px';
  pop.style.borderRadius = '3px';
  pop.style.boxShadow = '0 8px 24px rgba(0,0,0,0.6)';
  pop.style.gap = '6px';
  pop.style.display = 'flex';
  pop.style.flexWrap = 'wrap';
  pop.style.maxWidth = '200px';

  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
  pop.style.top = `${rect.bottom + 6}px`;

  for (const c of PRESET_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.width = '28px';
    b.style.height = '28px';
    b.style.background = c;
    b.style.color = c;
    b.style.border = '1px solid var(--bg-panel-border)';
    b.style.borderRadius = '3px';
    b.setAttribute('aria-pressed', c === currentColor ? 'true' : 'false');
    b.addEventListener('click', () => {
      onPick(c);
      pop.remove();
    });
    pop.appendChild(b);
  }

  document.body.appendChild(pop);
  setTimeout(() => {
    document.addEventListener('pointerdown', function dismiss(e) {
      if (!pop.contains(e.target)) {
        pop.remove();
        document.removeEventListener('pointerdown', dismiss);
      }
    });
  }, 0);
}

function openReassignDialog(api, store, district, others, onDone) {
  if (others.length === 0) {
    api.close();
    return;
  }
  api.open(({ modal, close }) => {
    let target = others[0].id;
    modal.innerHTML = `
      <h2 class="modal__title">Delete "${escapeHtml(district.name)}"?</h2>
      <div class="dialog-warn">
        <strong>Has tasks</strong>
        Move them to another district before deleting.
      </div>
      <div class="modal__field">
        <label class="modal__label">Move tasks to</label>
        <div class="chip-row" id="reassign-chips"></div>
      </div>
      <div class="modal__actions">
        <button type="button" class="btn btn--ghost" data-action="cancel">Cancel</button>
        <button type="button" class="btn btn--danger" data-action="confirm">Move &amp; Delete</button>
      </div>
    `;
    const chips = modal.querySelector('#reassign-chips');
    function paint() {
      chips.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.id === target ? 'true' : 'false'));
    }
    for (const d of others) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'chip';
      c.dataset.id = d.id;
      c.style.setProperty('--chip-color', d.color);
      c.innerHTML = `<span class="chip__dot"></span><span>${escapeHtml(d.name)}</span>`;
      c.addEventListener('click', () => { target = d.id; paint(); });
      chips.appendChild(c);
    }
    paint();
    modal.querySelector('[data-action="cancel"]').addEventListener('click', () => close());
    modal.querySelector('[data-action="confirm"]').addEventListener('click', () => {
      store.reassignAndRemoveDistrict(district.id, target);
      close();
      if (typeof onDone === 'function') onDone();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}
