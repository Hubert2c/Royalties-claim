// =============================================================================
// shared/widgets.js — interactive pieces shared by the portals
// -----------------------------------------------------------------------------
//   UIWidgets.theme.init()             light / dark mode (remembered per browser)
//   UIWidgets.bell(options)            notification bell with unread count
//   UIWidgets.barChart(el, data)       monthly bar chart (pure SVG, no library)
//   UIWidgets.flowBar(el, money)       where the money went: fee / paid / held
//   UIWidgets.mobileNav()              open/close the sidebar on small screens
//   UIWidgets.printDocument(title, html)  print a statement / certificate
//   UIWidgets.palette(options)         Ctrl+K quick search (government console)
// Requires shared/ui.js and shared/icons.js to be loaded first.
// =============================================================================
(function () {
  const { esc, money } = window.UI;
  const icon = (name) => window.UIIcons.svg(name);

  // ---------------------------------------------------------------------------
  // Theme: light / dark. Default follows the operating system setting.
  // ---------------------------------------------------------------------------
  const THEME_KEY = 'royalty_theme';
  const theme = {
    current() {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* storage blocked */ }
      if (saved === 'light' || saved === 'dark') return saved;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    },
    apply(name) {
      document.documentElement.setAttribute('data-theme', name);
      document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
        button.innerHTML = icon(name === 'dark' ? 'sun' : 'moon');
        button.setAttribute('aria-label', name === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
        button.title = button.getAttribute('aria-label');
      });
    },
    toggle() {
      const next = theme.current() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      theme.apply(next);
    },
    init() {
      theme.apply(theme.current());
      document.addEventListener('click', (event) => {
        if (event.target.closest('[data-theme-toggle]')) theme.toggle();
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Notification bell
  // options: { mount: element, api: (path, opts) => Promise, onOpenView: (view) => void }
  // ---------------------------------------------------------------------------
  function bell({ mount, api, onOpenView }) {
    mount.innerHTML = `
      <button class="icon-btn bell-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Notifications">
        ${icon('bell')}<span class="bell-count hidden">0</span>
      </button>
      <div class="bell-panel hidden" role="dialog" aria-label="Notifications">
        <div class="bell-head"><strong>Notifications</strong><button class="link-btn" type="button" data-read-all>Mark all as read</button></div>
        <div class="bell-list"><p class="empty-state">No notifications yet.</p></div>
      </div>`;
    const button = mount.querySelector('.bell-btn');
    const panel = mount.querySelector('.bell-panel');
    const countEl = mount.querySelector('.bell-count');
    const list = mount.querySelector('.bell-list');
    let items = [];
    let timer = null;

    async function refresh() {
      try {
        const data = await api('/api/notifications');
        items = data.notifications;
        countEl.textContent = data.unread > 9 ? '9+' : data.unread;
        countEl.classList.toggle('hidden', data.unread === 0);
        button.setAttribute('aria-label', `Notifications (${data.unread} unread)`);
        list.innerHTML = items.length ? items.map((n) => `
          <button class="notif-item ${Number(n.is_read) ? '' : 'unread'}" type="button" data-notif="${esc(n.id)}">
            <strong>${esc(n.title)}</strong>
            ${n.body ? `<span>${esc(n.body)}</span>` : ''}
            <small>${window.UI.dateTime(n.created_at)}</small>
          </button>`).join('') : '<p class="empty-state">You are all caught up.</p>';
      } catch (error) { /* bell is optional; ignore errors */ }
    }

    function close() { panel.classList.add('hidden'); button.setAttribute('aria-expanded', 'false'); }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !opening);
      button.setAttribute('aria-expanded', String(opening));
      if (opening) refresh();
    });
    document.addEventListener('click', (event) => { if (!mount.contains(event.target)) close(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });

    list.addEventListener('click', async (event) => {
      const item = event.target.closest('[data-notif]');
      if (!item) return;
      const note = items.find((n) => n.id === item.dataset.notif);
      await api(`/api/notifications/${encodeURIComponent(note.id)}/read`, { method: 'POST', body: {} }).catch(() => {});
      close();
      refresh();
      if (note && note.view && onOpenView) onOpenView(note.view);
    });
    mount.querySelector('[data-read-all]').addEventListener('click', async () => {
      await api('/api/notifications/read-all', { method: 'POST', body: {} }).catch(() => {});
      refresh();
    });

    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 30000); // check for new notifications every 30 seconds
    return { refresh, stop: () => clearInterval(timer) };
  }

  // ---------------------------------------------------------------------------
  // Bar chart (SVG). data: { labels: ['2026-01', ...], series: [{ name, values, tone }], format }
  // tone: 'primary' | 'paid' | 'held' | 'ink' — colours come from the CSS theme.
  // ---------------------------------------------------------------------------
  function shortMonth(label) {
    const d = new Date(`${label}-01T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? label : d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  }

  function niceMax(value) {
    if (value <= 0) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    const steps = [1, 2, 2.5, 5, 10];
    return steps.map((s) => s * power).find((v) => v >= value) || value;
  }

  function compact(value) {
    if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
    if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
    return String(Math.round(value));
  }

  function barChart(container, { labels, series, format = money }) {
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    const width = 640;
    const height = 220;
    const pad = { top: 12, right: 8, bottom: 26, left: 44 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
    const groupW = plotW / labels.length;
    const barW = Math.max(4, Math.min(22, (groupW - 8) / series.length));

    const gridLines = [0, 0.5, 1].map((f) => {
      const y = pad.top + plotH - f * plotH;
      return `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}"/>
        <text class="chart-axis" x="${pad.left - 8}" y="${y + 4}" text-anchor="end">${compact(max * f)}</text>`;
    }).join('');

    const bars = labels.map((label, i) => {
      const groupX = pad.left + i * groupW + (groupW - barW * series.length) / 2;
      const rects = series.map((s, j) => {
        const value = s.values[i] || 0;
        const h = (value / max) * plotH;
        return `<rect class="chart-bar tone-${s.tone || 'primary'}" x="${groupX + j * barW}" y="${pad.top + plotH - h}" width="${barW - 2}" height="${Math.max(h, value ? 2 : 0)}" rx="2">
          <title>${esc(s.name)}, ${esc(shortMonth(label))}: ${esc(format(value))}</title></rect>`;
      }).join('');
      return `${rects}<text class="chart-axis" x="${pad.left + i * groupW + groupW / 2}" y="${height - 8}" text-anchor="middle">${esc(shortMonth(label))}</text>`;
    }).join('');

    const legend = series.length > 1
      ? `<div class="chart-legend">${series.map((s) => `<span><i class="swatch tone-${s.tone || 'primary'}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
    const total = series.map((s) => `${s.name}: ${format(s.values.reduce((a, b) => a + b, 0))}`).join('; ');

    el.innerHTML = `${legend}<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`Last ${labels.length} months. ${total}`)}">${gridLines}${bars}</svg>`;
  }

  // ---------------------------------------------------------------------------
  // Money-flow bar: collected = admin fee + paid to creators + held + not yet distributed
  // ---------------------------------------------------------------------------
  function flowBar(container, { collected, adminFees, paid, held }) {
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    const remaining = Math.max(collected - adminFees - paid - held, 0);
    const parts = [
      { key: 'paid', label: 'Paid to creators', value: paid },
      { key: 'held', label: 'Held for unconfirmed splits', value: held },
      { key: 'fee', label: 'Administration fee', value: adminFees },
      { key: 'waiting', label: 'Not yet distributed', value: remaining }
    ];
    const pct = (v) => (collected > 0 ? (v / collected) * 100 : 0);
    el.innerHTML = `
      <div class="flow-total"><span>Collected from music users</span><strong>${money(collected)}</strong></div>
      <div class="flow-bar" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${money(p.value)}`).join(', '))}">
        ${parts.filter((p) => p.value > 0).map((p) => `<span class="flow-seg seg-${p.key}" style="width:${pct(p.value)}%" title="${esc(p.label)}: ${esc(money(p.value))}"></span>`).join('')}
      </div>
      <dl class="flow-legend">
        ${parts.map((p) => `<div><dt><i class="swatch seg-${p.key}"></i>${esc(p.label)}</dt><dd>${money(p.value)} <small>${pct(p.value).toFixed(0)}%</small></dd></div>`).join('')}
      </dl>`;
  }

  // ---------------------------------------------------------------------------
  // Mobile navigation: the menu button opens the sidebar as a drawer.
  // ---------------------------------------------------------------------------
  function mobileNav() {
    const shell = document.querySelector('.app-shell');
    if (!shell) return;
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-menu-toggle]')) {
        shell.classList.toggle('nav-open');
        return;
      }
      if (event.target.closest('.nav-item') || event.target.closest('.nav-backdrop')) shell.classList.remove('nav-open');
    });
  }

  // ---------------------------------------------------------------------------
  // Print a document (statement, licence certificate). The page's print CSS
  // hides everything except #printArea.
  // ---------------------------------------------------------------------------
  function printDocument(title, bodyHtml) {
    let area = document.querySelector('#printArea');
    if (!area) {
      area = document.createElement('div');
      area.id = 'printArea';
      document.body.appendChild(area);
    }
    area.innerHTML = `
      <div class="print-head">
        <div class="print-band"></div>
        <div><strong>Royalty Hub</strong> — National Music Royalty Tracking Platform<br />
          <small>Administered by the Rwanda Intellectual Property Office. Prototype document.</small></div>
      </div>
      <h1>${esc(title)}</h1>
      ${bodyHtml}
      <p class="print-foot">Printed ${new Date().toLocaleString('en-GB')}. Every amount can be traced to the usage records and the public audit log.</p>`;
    window.print();
  }

  // ---------------------------------------------------------------------------
  // Quick search palette (Ctrl+K / ⌘K).
  // options: { views: [{ view, label }], search: (q) => Promise<results>, onPick: (item) => void }
  // ---------------------------------------------------------------------------
  function palette({ views, search, onPick }) {
    const wrap = document.createElement('div');
    wrap.className = 'palette hidden';
    wrap.innerHTML = `
      <div class="palette-box" role="dialog" aria-label="Quick search">
        <label class="palette-input">${icon('search')}
          <input type="search" placeholder="Search works, ISRC, licensees, runs, clearance codes…" aria-label="Search" />
          <kbd>Esc</kbd></label>
        <div class="palette-results" role="listbox"></div>
      </div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('input');
    const resultsEl = wrap.querySelector('.palette-results');
    let results = [];
    let active = 0;
    let timer = null;

    function render() {
      resultsEl.innerHTML = results.length
        ? results.map((r, i) => `<button type="button" class="palette-item ${i === active ? 'active' : ''}" data-index="${i}" role="option">
            <span class="palette-type">${esc(r.type)}</span><strong>${esc(r.title)}</strong><small>${esc(r.detail || '')}</small></button>`).join('')
        : `<p class="empty-state">${input.value.trim().length < 2 ? 'Type at least 2 characters, or pick a page below.' : 'Nothing matches. Try an ISRC, a title or a TIN.'}</p>`;
    }

    async function update() {
      const q = input.value.trim().toLowerCase();
      const pages = views.filter((v) => !q || v.label.toLowerCase().includes(q)).map((v) => ({ type: 'Go to', title: v.label, view: v.view }));
      results = pages;
      active = 0;
      render();
      if (q.length >= 2) {
        try { results = [...(await search(q)), ...pages]; } catch (e) { /* keep page results */ }
        render();
      }
    }

    function open() { wrap.classList.remove('hidden'); input.value = ''; update(); input.focus(); }
    function close() { wrap.classList.add('hidden'); }
    function pick(index) { const item = results[index]; if (item) { close(); onPick(item); } }

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 180); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { active = Math.min(active + 1, results.length - 1); render(); event.preventDefault(); }
      if (event.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); event.preventDefault(); }
      if (event.key === 'Enter') { pick(active); event.preventDefault(); }
    });
    resultsEl.addEventListener('click', (event) => {
      const item = event.target.closest('[data-index]');
      if (item) pick(Number(item.dataset.index));
    });
    wrap.addEventListener('click', (event) => { if (event.target === wrap) close(); });
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); open(); }
      if (event.key === 'Escape') close();
    });
    return { open, close };
  }

  window.UIWidgets = { theme, bell, barChart, flowBar, mobileNav, printDocument, palette, compact };

  // Apply the theme as early as possible to avoid a flash of the wrong colours.
  theme.init();
  document.addEventListener('DOMContentLoaded', () => {
    window.UIIcons.render();
    theme.apply(theme.current()); // now the toggle buttons exist, give them their icon
  });
})();
