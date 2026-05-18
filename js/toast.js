let host = null;

export function mountToast(el) {
  host = el;
}

export function showToast(message, { variant = 'default', duration = 2400, action = null, onAction = null } = {}) {
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast--${variant}`;

  const msg = document.createElement('span');
  msg.className = 'toast__msg';
  msg.textContent = message;
  el.appendChild(msg);

  let actionTimeout = null;

  if (action && typeof onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = action;
    btn.addEventListener('click', () => {
      try { onAction(); } catch (err) { console.error(err); }
      dismiss();
    });
    el.appendChild(btn);
  }

  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));

  function dismiss() {
    if (actionTimeout) clearTimeout(actionTimeout);
    el.classList.remove('is-visible');
    setTimeout(() => el.remove(), 300);
  }

  actionTimeout = setTimeout(dismiss, duration);

  return { dismiss };
}
