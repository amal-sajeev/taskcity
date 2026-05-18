export function mountKeyboard({ ui }) {
  function isTyping(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function isDesktop() {
    return window.matchMedia('(min-width: 900px)').matches;
  }

  function showHelp() {
    const el = document.getElementById('kbd-help');
    if (!el) return;
    if (typeof el.showModal === 'function') {
      try { el.showModal(); } catch (_) {}
    } else {
      el.setAttribute('open', '');
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) {
      if (e.key === 'Escape') ui.clearSelection && ui.clearSelection();
      return;
    }

    switch (e.key) {
      case 'n':
      case 'N':
        e.preventDefault();
        ui.openAddModal && ui.openAddModal();
        break;
      case 'j':
      case 'J':
      case 'ArrowDown':
        e.preventDefault();
        ui.selectNext && ui.selectNext();
        break;
      case 'k':
      case 'K':
      case 'ArrowUp':
        e.preventDefault();
        ui.selectPrev && ui.selectPrev();
        break;
      case ' ':
      case 'Enter':
        if (ui.completeSelected) {
          e.preventDefault();
          ui.completeSelected();
        }
        break;
      case 'd':
      case 'D':
        if (ui.deleteSelected) {
          e.preventDefault();
          ui.deleteSelected();
        }
        break;
      case 'Escape':
        ui.clearSelection && ui.clearSelection();
        break;
      case '?':
        e.preventDefault();
        showHelp();
        break;
      default:
        break;
    }
  });
}
