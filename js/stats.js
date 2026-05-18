export function mountStats({ store, containerEl }) {
  if (!containerEl) return { refresh() {}, mount() {}, unmount() {} };

  function refresh() {
    const data = store.raw();
    const districts = store.getDistricts();
    const tasks = data.tasks || [];

    const built = tasks.filter(t => t.status === 'complete').length;
    const pending = tasks.filter(t => t.status === 'pending').length;

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const cutoff7 = now - 7 * day;
    const cutoff14 = now - 14 * day;

    let last7 = 0, prev7 = 0;
    for (const t of tasks) {
      if (t.status !== 'complete' || !t.completedAt) continue;
      const ts = Date.parse(t.completedAt);
      if (isNaN(ts)) continue;
      if (ts >= cutoff7) last7++;
      else if (ts >= cutoff14) prev7++;
    }
    const delta = last7 - prev7;
    const deltaSign = delta > 0 ? '+' : delta < 0 ? '\u2212' : '';
    const deltaAbs = Math.abs(delta);
    const deltaPct = prev7 > 0
      ? Math.round(((last7 - prev7) / prev7) * 100)
      : (last7 > 0 ? 100 : 0);

    const perDistrict = districts.map(d => {
      const dTasks = tasks.filter(t => t.districtId === d.id);
      const b = dTasks.filter(t => t.status === 'complete').length;
      const p = dTasks.filter(t => t.status === 'pending').length;
      const total = b + p;
      const size = Math.max(3, d.size || 3);
      const capacity = size * size;
      return { d, built: b, pending: p, total, capacity, size };
    });

    const maxDistrictTotal = Math.max(1, ...perDistrict.map(x => x.total));

    const recent = tasks
      .filter(t => t.status === 'complete' && t.completedAt)
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
      .slice(0, 10);
    const districtById = new Map(districts.map(d => [d.id, d]));

    const html = `
      <header class="stats-view__header">
        <h2 class="stats-view__title">CITY STATS</h2>
        <span class="stats-view__subtitle">Operational telemetry</span>
      </header>

      <section class="stats-cards">
        <div class="stats-card stats-card--accent">
          <span class="stats-card__label">BUILDINGS BUILT</span>
          <span class="stats-card__value">${built}</span>
          <span class="stats-card__sub">Total completions</span>
        </div>
        <div class="stats-card">
          <span class="stats-card__label">PENDING</span>
          <span class="stats-card__value">${pending}</span>
          <span class="stats-card__sub">Open directives</span>
        </div>
      </section>

      <section class="stats-section">
        <h3 class="stats-section__title">DISTRICT LOAD</h3>
        <div class="stats-bars">
          ${perDistrict.length === 0
            ? '<p class="stats-empty">No districts yet.</p>'
            : perDistrict.map(x => renderDistrictBar(x, maxDistrictTotal)).join('')}
        </div>
      </section>

      <section class="stats-section">
        <h3 class="stats-section__title">LAST 7 DAYS</h3>
        <div class="stats-delta">
          <span class="stats-delta__value">${last7}</span>
          <span class="stats-delta__label">completed</span>
          <span class="stats-delta__change ${delta >= 0 ? 'is-up' : 'is-down'}">
            ${deltaSign}${deltaAbs}
            <span class="stats-delta__pct">${deltaSign}${Math.abs(deltaPct)}%</span>
          </span>
          <span class="stats-delta__sub">vs previous 7 days (${prev7})</span>
        </div>
      </section>

      <section class="stats-section">
        <h3 class="stats-section__title">RECENT ACTIVITY</h3>
        <ul class="stats-activity">
          ${recent.length === 0
            ? '<li class="stats-empty">No completions yet.</li>'
            : recent.map(t => renderActivityRow(t, districtById.get(t.districtId), now)).join('')}
        </ul>
      </section>
    `;

    containerEl.innerHTML = html;
  }

  function renderDistrictBar(x, maxTotal) {
    const total = x.total || 0;
    const completedW = total === 0 ? 0 : Math.round((x.built / maxTotal) * 100);
    const pendingW = total === 0 ? 0 : Math.round((x.pending / maxTotal) * 100);
    const color = x.d.color;
    return `
      <div class="stats-bar" style="--district-color:${color};">
        <div class="stats-bar__head">
          <span class="stats-bar__name">${escapeHtml(x.d.name.toUpperCase())}</span>
          <span class="stats-bar__count">${x.built}/${x.capacity}</span>
        </div>
        <div class="stats-bar__track">
          <span class="stats-bar__fill stats-bar__fill--built" style="width:${completedW}%"></span>
          <span class="stats-bar__fill stats-bar__fill--pending" style="width:${pendingW}%; left:${completedW}%"></span>
        </div>
        <div class="stats-bar__sub">
          ${x.built} built &middot; ${x.pending} pending &middot; ${x.size}\u00D7${x.size} grid
        </div>
      </div>
    `;
  }

  function renderActivityRow(task, district, now) {
    const ts = Date.parse(task.completedAt) || now;
    const rel = relativeTime(now - ts);
    const color = district ? district.color : '#5a6a90';
    const name = district ? district.name : 'unknown';
    return `
      <li class="stats-activity__row">
        <span class="stats-activity__dot" style="background:${color};box-shadow:0 0 8px ${color};"></span>
        <span class="stats-activity__title">${escapeHtml(task.title)}</span>
        <span class="stats-activity__meta">${escapeHtml(name.toUpperCase())} &middot; ${rel}</span>
      </li>
    `;
  }

  function relativeTime(ms) {
    if (ms < 60 * 1000) return 'just now';
    const mins = Math.floor(ms / (60 * 1000));
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    const wks = Math.floor(days / 7);
    if (wks < 5) return wks + 'w ago';
    const mos = Math.floor(days / 30);
    if (mos < 12) return mos + 'mo ago';
    return Math.floor(days / 365) + 'y ago';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  return {
    mount() { refresh(); },
    unmount() {},
    refresh
  };
}
