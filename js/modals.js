import { openDistrictsManager } from './districts.js';

let rootEl = null;
let activeCleanup = null;

export function mountModals({ rootEl: el }) {
  rootEl = el;

  return {
    openAddTask,
    openDistricts: openDistrictsManager.bind(null, getApi())
  };
}

function getApi() {
  return { open, close };
}

function close() {
  if (activeCleanup) activeCleanup();
  activeCleanup = null;
  rootEl.classList.remove('is-active');
  rootEl.innerHTML = '';
  rootEl.setAttribute('aria-hidden', 'true');
}

function open(renderInto) {
  close();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', () => close());

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  rootEl.appendChild(backdrop);
  rootEl.appendChild(modal);
  rootEl.setAttribute('aria-hidden', 'false');

  requestAnimationFrame(() => rootEl.classList.add('is-active'));

  const cleanup = renderInto({ modal, close });

  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  activeCleanup = () => {
    document.removeEventListener('keydown', onKey);
    if (typeof cleanup === 'function') cleanup();
  };
}

function openAddTask({ districts, defaultDistrictId, onSubmit }) {
  open(({ modal, close }) => {
    let selectedId = defaultDistrictId;

    modal.innerHTML = `
      <h2 class="modal__title">New Task</h2>
      <div class="modal__field">
        <label class="modal__label" for="task-title">Title</label>
        <input class="modal__input" id="task-title" type="text" autocomplete="off" maxlength="200" placeholder="What do you need to do?" />
      </div>
      <div class="modal__field">
        <label class="modal__label">District</label>
        <div class="chip-row" id="district-chips" role="radiogroup" aria-label="District"></div>
      </div>
      <div class="modal__actions">
        <button type="button" class="btn btn--ghost" data-action="cancel">Cancel</button>
        <button type="button" class="btn btn--primary" data-action="submit">Add</button>
      </div>
    `;

    const chips = modal.querySelector('#district-chips');
    const input = modal.querySelector('#task-title');
    const submitBtn = modal.querySelector('[data-action="submit"]');

    function setSelected(id) {
      selectedId = id;
      const district = districts.find(d => d.id === id);
      if (district) {
        modal.style.setProperty('--district-color', district.color);
        submitBtn.style.setProperty('--district-color', district.color);
      }
      chips.querySelectorAll('.chip').forEach(c => {
        c.setAttribute('aria-pressed', c.dataset.id === id ? 'true' : 'false');
      });
    }

    for (const d of districts) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'chip';
      c.setAttribute('role', 'radio');
      c.dataset.id = d.id;
      c.style.setProperty('--chip-color', d.color);
      c.innerHTML = `<span class="chip__dot"></span><span>${escapeHtml(d.name)}</span>`;
      c.addEventListener('click', () => setSelected(d.id));
      chips.appendChild(c);
    }
    setSelected(selectedId);

    function submit() {
      const title = input.value.trim();
      if (!title) {
        input.focus();
        return;
      }
      onSubmit({ title, districtId: selectedId });
      close();
    }

    modal.querySelector('[data-action="cancel"]').addEventListener('click', () => close());
    submitBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });

    setTimeout(() => input.focus(), 80);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export { open as _openModal, close as _closeModal };
